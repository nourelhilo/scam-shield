import { Worker } from "node:worker_threads";
import { loadModelFromDir, type LinearTextModel, type ModelInfo, type Prediction } from "./linear-model.ts";

/**
 * Inference engines. The backend talks to an MlEngine; it never loads models itself.
 *
 *  WorkerPoolEngine (default): a small pool of worker threads, each holding one copy of the
 *    verified model. Gives real per-request timeouts (a stuck worker is terminated and
 *    replaced), a V8 heap limit per worker, a bounded queue, and keeps inference off the
 *    HTTP event loop.
 *  InProcessEngine: same model on the main thread. For tools and tests; inference is a few
 *    milliseconds but cannot be pre-empted, so it is not the production default.
 */
export type MlEngineErrorKind = "timeout" | "queue_full" | "unavailable" | "engine_error" | "invalid_input";

export class MlEngineError extends Error {
  override name = "MlEngineError";
  readonly kind: MlEngineErrorKind;
  constructor(kind: MlEngineErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

export type EngineState = "starting" | "ready" | "unavailable";

export interface EngineStatus {
  engine: string;
  state: EngineState;
  modelVersion: string | null;
  reason: string | null;
  workers: number;
  queueDepth: number;
}

export interface MlEngine {
  readonly name: string;
  /** Resolves once the model is loaded (or the engine has given up). */
  ready(): Promise<EngineStatus>;
  status(): EngineStatus;
  info(): ModelInfo | null;
  predict(text: string, timeoutMs: number): Promise<Prediction>;
  close(): Promise<void>;
}

export class InProcessEngine implements MlEngine {
  readonly name = "in-process";
  private readonly model: LinearTextModel | null;
  private readonly reason: string | null;

  constructor(source: { modelDir: string } | { model: LinearTextModel }) {
    let model: LinearTextModel | null = null;
    let reason: string | null = null;
    try {
      model = "model" in source ? source.model : loadModelFromDir(source.modelDir);
    } catch (error) {
      reason = error instanceof Error && error.name === "ModelIntegrityError" ? "model_integrity_check_failed" : "model_load_failed";
    }
    this.model = model;
    this.reason = reason;
  }

  status(): EngineStatus {
    return { engine: this.name, state: this.model ? "ready" : "unavailable", modelVersion: this.model?.info.modelVersion ?? null, reason: this.reason, workers: 0, queueDepth: 0 };
  }

  async ready() {
    return this.status();
  }

  info() {
    return this.model?.info ?? null;
  }

  async predict(text: string): Promise<Prediction> {
    if (!this.model) throw new MlEngineError("unavailable", "The model is not loaded.");
    return this.model.predict(text);
  }

  async close() {}
}

interface Job {
  id: number;
  text: string;
  resolve: (p: Prediction) => void;
  reject: (e: MlEngineError) => void;
  timer: NodeJS.Timeout;
  settled: boolean;
}

interface Slot {
  worker: Worker | null;
  ready: boolean;
  job: Job | null;
}

export interface WorkerPoolOptions {
  modelDir: string;
  workers: number;
  maxQueue: number;
  maxChars: number;
  /** V8 old-generation heap limit per worker (MB). The worker is killed if it exceeds it. */
  maxHeapMb: number;
  /** Restart budget: more crashes than this within `crashWindowMs` marks the engine unavailable. */
  maxCrashes?: number;
  crashWindowMs?: number;
  /** Overridable for tests (e.g. a worker that hangs or crashes on purpose). */
  workerUrl?: URL;
}

export class WorkerPoolEngine implements MlEngine {
  readonly name = "worker-pool";
  private readonly opts: Required<Omit<WorkerPoolOptions, "workerUrl">> & { workerUrl: URL };
  private readonly slots: Slot[];
  private readonly queue: Job[] = [];
  private nextId = 1;
  private state: EngineState = "starting";
  private reason: string | null = null;
  private modelInfo: ModelInfo | null = null;
  private crashes: number[] = [];
  private closing = false;
  private readyWaiters: ((s: EngineStatus) => void)[] = [];

  constructor(options: WorkerPoolOptions) {
    this.opts = {
      maxCrashes: 5,
      crashWindowMs: 60_000,
      workerUrl: new URL("./inference-worker.ts", import.meta.url),
      ...options,
    };
    this.slots = Array.from({ length: Math.max(1, options.workers) }, () => ({ worker: null, ready: false, job: null }));
    this.slots.forEach((_, i) => this.spawn(i));
  }

  status(): EngineStatus {
    return { engine: this.name, state: this.state, modelVersion: this.modelInfo?.modelVersion ?? null, reason: this.reason, workers: this.slots.filter((s) => s.ready).length, queueDepth: this.queue.length };
  }

  info() {
    return this.modelInfo;
  }

  ready(): Promise<EngineStatus> {
    if (this.state !== "starting") return Promise.resolve(this.status());
    return new Promise((resolve) => this.readyWaiters.push(resolve));
  }

  private setState(state: EngineState, reason: string | null) {
    this.state = state;
    this.reason = reason;
    if (state !== "starting") {
      const waiters = this.readyWaiters.splice(0);
      waiters.forEach((w) => w(this.status()));
    }
    if (state === "unavailable") {
      for (const job of this.queue.splice(0)) this.settle(job, new MlEngineError("unavailable", "The model is unavailable."));
    }
  }

  private spawn(index: number) {
    if (this.closing || this.state === "unavailable") return;
    const slot = this.slots[index]!;
    const worker = new Worker(this.opts.workerUrl, {
      workerData: { modelDir: this.opts.modelDir, maxChars: this.opts.maxChars },
      resourceLimits: { maxOldGenerationSizeMb: this.opts.maxHeapMb, maxYoungGenerationSizeMb: 32 },
      stdout: true,
      stderr: true,
    });
    // Worker output is discarded so nothing from inference can reach the logs.
    worker.stdout.resume();
    worker.stderr.resume();
    slot.worker = worker;
    slot.ready = false;

    worker.on("message", (msg: { type: string; id?: number; ok?: boolean; prediction?: Prediction; error?: string; info?: ModelInfo; reason?: string }) => {
      if (msg.type === "ready") {
        slot.ready = true;
        this.modelInfo = msg.info ?? null;
        if (this.state === "starting") this.setState("ready", null);
        this.pump();
      } else if (msg.type === "load_failed") {
        this.setState("unavailable", msg.reason === "ModelIntegrityError" ? "model_integrity_check_failed" : "model_load_failed");
      } else if (msg.type === "result") {
        const job = slot.job;
        if (!job || job.id !== msg.id) return;
        slot.job = null;
        if (msg.ok && msg.prediction) this.settle(job, msg.prediction);
        else this.settle(job, new MlEngineError(msg.error === "invalid_input" ? "invalid_input" : "engine_error", "Inference failed."));
        this.pump();
      }
    });
    worker.on("error", () => {
      // Followed by 'exit'; the job is failed there.
    });
    worker.on("exit", () => {
      if (slot.worker !== worker) return;
      slot.worker = null;
      slot.ready = false;
      if (slot.job) {
        this.settle(slot.job, new MlEngineError("engine_error", "The inference worker stopped."));
        slot.job = null;
      }
      if (this.closing || this.state === "unavailable") return;
      const now = Date.now();
      this.crashes = this.crashes.filter((t) => now - t < this.opts.crashWindowMs);
      this.crashes.push(now);
      if (this.crashes.length > this.opts.maxCrashes) {
        this.setState("unavailable", "worker_crash_loop");
        return;
      }
      this.spawn(index);
    });
  }

  private settle(job: Job, outcome: Prediction | MlEngineError) {
    if (job.settled) return;
    job.settled = true;
    clearTimeout(job.timer);
    if (outcome instanceof MlEngineError) job.reject(outcome);
    else job.resolve(outcome);
  }

  private pump() {
    for (const slot of this.slots) {
      if (!slot.ready || slot.job || !slot.worker) continue;
      const job = this.queue.shift();
      if (!job) return;
      slot.job = job;
      slot.worker.postMessage({ id: job.id, text: job.text });
    }
  }

  predict(text: string, timeoutMs: number): Promise<Prediction> {
    if (this.closing || this.state === "unavailable") return Promise.reject(new MlEngineError("unavailable", "The model is unavailable."));
    if (text.length > this.opts.maxChars) return Promise.reject(new MlEngineError("invalid_input", "Input too large for the model."));
    if (this.queue.length >= this.opts.maxQueue) return Promise.reject(new MlEngineError("queue_full", "Too many analyses in progress."));
    return new Promise<Prediction>((resolve, reject) => {
      const job: Job = { id: this.nextId++, text, resolve, reject, settled: false, timer: setTimeout(() => this.onTimeout(job), timeoutMs) };
      this.queue.push(job);
      this.pump();
    });
  }

  private onTimeout(job: Job) {
    if (job.settled) return;
    const queued = this.queue.indexOf(job);
    if (queued >= 0) this.queue.splice(queued, 1);
    this.settle(job, new MlEngineError("timeout", "Inference timed out."));
    // A worker still busy with this job is stuck: replace it (its 'exit' handler respawns).
    const slot = this.slots.find((s) => s.job === job);
    if (slot?.worker) {
      slot.job = null;
      slot.ready = false;
      void slot.worker.terminate();
    }
  }

  async close() {
    this.closing = true;
    for (const job of this.queue.splice(0)) this.settle(job, new MlEngineError("unavailable", "The engine is shutting down."));
    await Promise.all(
      this.slots.map(async (slot) => {
        if (slot.job) this.settle(slot.job, new MlEngineError("unavailable", "The engine is shutting down."));
        const w = slot.worker;
        slot.worker = null;
        if (w) await w.terminate();
      }),
    );
    if (this.state === "starting") this.setState("unavailable", "closed");
  }
}
