import { buildApp } from "./app.ts";
import { createMailer } from "./auth/mailer.ts";
import type { AppConfig } from "./config.ts";
import { createDatabase } from "./db/database.ts";
import { migrate } from "./db/migrate.ts";
import { seedArticles } from "./db/seed.ts";
import { InProcessEngine, WorkerPoolEngine, type MlEngine } from "./ml/engine.ts";
import { MlService } from "./ml/ml-service.ts";
import { DEFAULT_MODEL_DIR } from "./ml/model-path.ts";
import { OcrService, TesseractEngine } from "./ocr/ocr-service.ts";

/** Build the ML engine from configuration. Models are only ever loaded from a local directory. */
export function createMlEngine(config: AppConfig["ml"]): MlEngine | null {
  if (!config.enabled) return null;
  const modelDir = config.modelDir ?? DEFAULT_MODEL_DIR;
  return config.engine === "in-process"
    ? new InProcessEngine({ modelDir })
    : new WorkerPoolEngine({ modelDir, workers: config.workers, maxQueue: config.maxQueue, maxChars: config.maxInputChars, maxHeapMb: config.workerMaxHeapMb });
}

/** Composition root: wires concrete implementations from configuration. */
export async function createServer(config: AppConfig) {
  const db = await createDatabase({ url: config.db.url, pgliteDataDir: config.db.pgliteDataDir ?? (config.isTest ? undefined : ".data/pglite") });
  if (config.db.autoMigrate) {
    await migrate(db);
    if (db.kind === "pglite") await seedArticles(db);
  }

  const mlLog: { fn?: (event: Record<string, unknown>) => void } = {};
  const ml = new MlService(createMlEngine(config.ml), {
    timeoutMs: config.ml.timeoutMs,
    maxInputChars: config.ml.maxInputChars,
    log: (event) => mlLog.fn?.(event),
  });
  const mlStatus = await ml.ready();

  const app = await buildApp({
    config,
    db,
    mailer: createMailer(config.mail),
    ocr: new OcrService(config.ocr.enabled ? new TesseractEngine({ langs: config.ocr.langs, cacheDir: config.ocr.cacheDir }) : null, {
      timeoutMs: config.ocr.timeoutMs,
      maxQueue: 3,
    }),
    ml,
  });
  // ML events carry metadata only (status, reason, band, timing, model version) - never submitted content.
  mlLog.fn = (event) => app.log.info(event, "ml");
  if (!mlStatus) app.log.warn("ML classifier disabled (ML_ENABLED=false): analysis uses rule-based checks only.");
  else if (mlStatus.state !== "ready") app.log.error({ reason: mlStatus.reason }, "ML classifier unavailable: analysis uses rule-based checks only.");
  else app.log.info({ modelVersion: mlStatus.modelVersion, engine: mlStatus.engine, workers: mlStatus.workers }, "ML classifier ready");
  if (config.legacyAiSettings.length > 0) {
    app.log.warn({ ignored: config.legacyAiSettings }, "External AI settings are no longer used and were ignored. ScamShield uses its own ML model.");
  }
  app.addHook("onClose", async () => {
    await app.ctx.ocr.close();
    await ml.close();
    await db.close();
  });
  return app;
}
