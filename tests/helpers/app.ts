import type { FastifyInstance } from "fastify";
import { AiService } from "../../server/ai/ai-service.ts";
import type { AiProvider } from "../../server/ai/types.ts";
import { buildApp } from "../../server/app.ts";
import { MemoryMailer } from "../../server/auth/mailer.ts";
import { loadConfig } from "../../server/config.ts";
import { createDatabase } from "../../server/db/database.ts";
import { migrate } from "../../server/db/migrate.ts";
import { seedArticles } from "../../server/db/seed.ts";
import { OcrService, type OcrEngine } from "../../server/ocr/ocr-service.ts";

/**
 * Builds the real Fastify app against a fresh in-memory PostgreSQL (PGlite) database.
 * External services are replaced by test doubles: MemoryMailer (no email is sent),
 * an optional fake AI provider, and an optional fake OCR engine. These are MOCKED tests,
 * not integrations with real Anthropic/SMTP/Tesseract services.
 */
export interface TestAppOptions {
  env?: Record<string, string>;
  aiProvider?: AiProvider | null;
  aiTimeoutMs?: number;
  ocrEngine?: OcrEngine | null;
  seed?: boolean;
}

export interface TestApp {
  app: FastifyInstance;
  mailer: MemoryMailer;
  close: () => Promise<void>;
}

export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const config = loadConfig({ NODE_ENV: "test", MAIL_TRANSPORT: "memory", RATE_LIMIT_ENABLED: "false", ...options.env });
  const db = await createDatabase({});
  await migrate(db);
  if (options.seed) await seedArticles(db);
  const mailer = new MemoryMailer();
  const app = await buildApp({
    config,
    db,
    mailer,
    ai: new AiService(options.aiProvider ?? null, { timeoutMs: options.aiTimeoutMs ?? 2000, maxRetries: 1, maxInputChars: config.ai.maxInputChars }),
    ocr: new OcrService(options.ocrEngine ?? null, { timeoutMs: 2000, maxQueue: 3 }),
  });
  await app.ready();
  return {
    app,
    mailer,
    close: async () => {
      await app.close();
      await db.close();
    },
  };
}

export function tokenFromMail(text: string, prefix: "ev" | "pr") {
  const match = text.match(new RegExp(`${prefix}_[A-Za-z0-9_-]{43}`));
  if (!match) throw new Error("token not found in email");
  return match[0];
}

/** Register, verify via the emailed token, and sign in. Returns the bearer token. */
export async function signUp(t: TestApp, email: string, password = "correct horse battery") {
  const reg = await t.app.inject({ method: "POST", url: "/api/auth/register", payload: { email, password } });
  if (reg.statusCode !== 202) throw new Error(`register failed: ${reg.statusCode} ${reg.body}`);
  const token = tokenFromMail(t.mailer.lastTo(email)!.text, "ev");
  const ver = await t.app.inject({ method: "POST", url: "/api/auth/verify-email", payload: { token } });
  if (ver.statusCode !== 200) throw new Error(`verify failed: ${ver.statusCode}`);
  const login = await t.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  if (login.statusCode !== 200) throw new Error(`login failed: ${login.statusCode} ${login.body}`);
  return login.json().token as string;
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
