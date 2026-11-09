import { AnthropicProvider } from "./ai/anthropic-provider.ts";
import { AiService } from "./ai/ai-service.ts";
import { buildApp } from "./app.ts";
import { createMailer } from "./auth/mailer.ts";
import type { AppConfig } from "./config.ts";
import { createDatabase } from "./db/database.ts";
import { migrate } from "./db/migrate.ts";
import { seedArticles } from "./db/seed.ts";
import { OcrService, TesseractEngine } from "./ocr/ocr-service.ts";

/** Composition root: wires concrete implementations from configuration. */
export async function createServer(config: AppConfig) {
  const db = await createDatabase({ url: config.db.url, pgliteDataDir: config.db.pgliteDataDir ?? (config.isTest ? undefined : ".data/pglite") });
  if (config.db.autoMigrate) {
    await migrate(db);
    if (db.kind === "pglite") await seedArticles(db);
  }

  const provider =
    config.ai.provider === "anthropic" && config.ai.apiKey
      ? new AnthropicProvider({ apiKey: config.ai.apiKey, model: config.ai.model, maxOutputTokens: config.ai.maxOutputTokens, timeoutMs: config.ai.timeoutMs })
      : null;

  const aiLog: { fn?: (event: Record<string, unknown>) => void } = {};
  const app = await buildApp({
    config,
    db,
    mailer: createMailer(config.mail),
    ocr: new OcrService(config.ocr.enabled ? new TesseractEngine({ langs: config.ocr.langs, cacheDir: config.ocr.cacheDir }) : null, {
      timeoutMs: config.ocr.timeoutMs,
      maxQueue: 3,
    }),
    ai: new AiService(provider, {
      timeoutMs: config.ai.timeoutMs,
      maxRetries: config.ai.maxRetries,
      maxInputChars: config.ai.maxInputChars,
      log: (event) => aiLog.fn?.(event),
    }),
  });
  // AI events carry metadata only (status, timings, counts) - never submitted content.
  aiLog.fn = (event) => app.log.info(event, "ai");
  app.addHook("onClose", async () => {
    await app.ctx.ocr.close();
    await db.close();
  });
  return app;
}
