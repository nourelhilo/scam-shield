import { mkdirSync } from "node:fs";
import { AppError } from "../lib/errors.ts";

/**
 * OCR abstraction. The real engine is Tesseract (tesseract.js, WebAssembly) running in-process.
 *
 * Safe handling:
 *  - Images are processed from memory buffers; nothing is written to disk, so there are no
 *    temporary files to clean up. Buffers are dropped after the request.
 *  - Uploaded content is never executed; Tesseract only decodes pixel data.
 *  - Jobs run one at a time with a short queue, and each job has a timeout.
 *  - Tesseract downloads its language models (traineddata) from its CDN on first use and caches
 *    them in OCR_CACHE_DIR. This is a fixed, vendor-controlled destination - never user input.
 */
export interface OcrEngine {
  readonly name: string;
  recognize(image: Buffer, signal: AbortSignal): Promise<{ text: string; confidence: number | null }>;
  close?(): Promise<void>;
}

export class OcrService {
  private queue: Promise<unknown> = Promise.resolve();
  private pending = 0;

  constructor(
    private readonly engine: OcrEngine | null,
    private readonly options: { timeoutMs: number; maxQueue: number },
  ) {}

  get enabled() {
    return this.engine !== null;
  }

  async extractText(image: Buffer) {
    if (!this.engine) throw new AppError(503, "OCR_DISABLED", "Screenshot analysis is not enabled on this server.");
    if (this.pending >= this.options.maxQueue) throw new AppError(503, "OCR_BUSY", "Screenshot analysis is busy. Try again shortly.");
    this.pending++;
    const engine = this.engine;
    const run = async () => {
      const controller = new AbortController();
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new AppError(504, "OCR_TIMEOUT", "Reading the screenshot took too long."));
        }, this.options.timeoutMs);
      });
      try {
        return await Promise.race([engine.recognize(image, controller.signal), timeout]);
      } finally {
        clearTimeout(timer);
      }
    };
    const job = this.queue.then(run, run);
    this.queue = job.catch(() => undefined);
    try {
      return await job;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(422, "OCR_FAILED", "The screenshot could not be read.");
    } finally {
      this.pending--;
    }
  }

  async close() {
    await this.engine?.close?.();
  }
}

/** tesseract.js engine with a single lazily created worker. */
export class TesseractEngine implements OcrEngine {
  readonly name = "tesseract";
  private worker: Promise<import("tesseract.js").Worker> | null = null;

  constructor(private readonly options: { langs: string; cacheDir: string }) {}

  private getWorker() {
    this.worker ??= (async () => {
      mkdirSync(this.options.cacheDir, { recursive: true });
      const { createWorker } = await import("tesseract.js");
      return createWorker(this.options.langs.split("+"), 1, { cachePath: this.options.cacheDir });
    })();
    return this.worker;
  }

  async recognize(image: Buffer) {
    const worker = await this.getWorker();
    const { data } = await worker.recognize(image);
    return { text: data.text ?? "", confidence: typeof data.confidence === "number" ? data.confidence : null };
  }

  async close() {
    if (this.worker) await (await this.worker).terminate();
    this.worker = null;
  }
}
