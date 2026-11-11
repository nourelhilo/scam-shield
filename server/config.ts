import { z } from "zod";

/**
 * All runtime configuration is read from environment variables and validated here.
 * Server-only secrets (DATABASE_URL, SMTP credentials) never leave the server.
 */
const bool = (fallback: boolean) =>
  z
    .enum(["true", "false", "1", "0"])
    .optional()
    .transform((v) => (v === undefined ? fallback : v === "true" || v === "1"));

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).optional(),
  TRUST_PROXY: bool(false),
  PUBLIC_APP_URL: z.string().url().default("http://127.0.0.1:3000"),
  CORS_ORIGINS: csv,
  SERVE_FRONTEND: bool(true),

  DATABASE_URL: z.string().optional(),
  PGLITE_DATA_DIR: z.string().optional(),
  DB_AUTO_MIGRATE: bool(false),

  // ScamShield's own ML classifier (local inference; no external AI service).
  ML_ENABLED: bool(true),
  ML_MODEL_DIR: z.string().optional(),
  ML_ENGINE: z.enum(["worker", "in-process"]).default("worker"),
  ML_WORKERS: z.coerce.number().int().min(1).max(8).default(1),
  ML_TIMEOUT_MS: z.coerce.number().int().min(100).max(10000).default(1500),
  ML_MAX_QUEUE: z.coerce.number().int().min(1).max(1000).default(64),
  ML_WORKER_MAX_HEAP_MB: z.coerce.number().int().min(64).max(2048).default(256),

  REQUIRE_EMAIL_VERIFICATION: bool(true),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 90).default(24 * 7),

  MAIL_TRANSPORT: z.enum(["console", "smtp", "memory"]).default("console"),
  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().default("ScamShield <no-reply@scamshield.local>"),

  OCR_ENABLED: bool(false),
  OCR_LANGS: z.string().default("eng+ara"),
  OCR_CACHE_DIR: z.string().default(".cache/tesseract"),
  OCR_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(30000),
  UPLOAD_MAX_BYTES: z.coerce.number().int().min(1024).max(10 * 1024 * 1024).default(5 * 1024 * 1024),

  RATE_LIMIT_ENABLED: bool(true),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  // Treat empty values (e.g. `DATABASE_URL=` in .env) as unset.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ""));
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    // Do not echo values: they may contain secrets.
    throw new Error(`Invalid environment configuration for: ${fields}`);
  }
  const c = parsed.data;
  const isProd = c.NODE_ENV === "production";

  if (isProd && !c.DATABASE_URL) {
    throw new Error("DATABASE_URL is required in production. The embedded PGlite database is for development only.");
  }
  if (c.MAIL_TRANSPORT === "smtp" && !c.SMTP_URL) {
    throw new Error("MAIL_TRANSPORT=smtp requires SMTP_URL.");
  }
  if (isProd && c.MAIL_TRANSPORT !== "smtp") {
    throw new Error("Production requires MAIL_TRANSPORT=smtp so verification and reset emails are delivered.");
  }

  const defaultDevOrigins = ["http://127.0.0.1:4173", "http://localhost:4173", "http://127.0.0.1:3000", "http://localhost:3000"];

  return {
    env: c.NODE_ENV,
    isProd,
    isTest: c.NODE_ENV === "test",
    host: c.HOST,
    port: c.PORT,
    logLevel: c.LOG_LEVEL ?? (c.NODE_ENV === "test" ? "silent" : "info"),
    trustProxy: c.TRUST_PROXY,
    publicAppUrl: c.PUBLIC_APP_URL.replace(/\/+$/, ""),
    corsOrigins: c.CORS_ORIGINS.length > 0 ? c.CORS_ORIGINS : isProd ? [] : defaultDevOrigins,
    serveFrontend: c.SERVE_FRONTEND,
    db: {
      url: c.DATABASE_URL,
      pgliteDataDir: c.PGLITE_DATA_DIR,
      // PGlite (local/dev) always auto-migrates; a real Postgres only does when explicitly enabled.
      autoMigrate: c.DB_AUTO_MIGRATE || !c.DATABASE_URL,
    },
    ml: {
      enabled: c.ML_ENABLED,
      modelDir: c.ML_MODEL_DIR,
      engine: c.ML_ENGINE,
      workers: c.ML_WORKERS,
      timeoutMs: c.ML_TIMEOUT_MS,
      maxQueue: c.ML_MAX_QUEUE,
      workerMaxHeapMb: c.ML_WORKER_MAX_HEAP_MB,
      // Structured emails can carry a subject (998) on top of a 10,000-character body.
      maxInputChars: 12_000,
    },
    /** External-AI settings from the removed Anthropic integration are ignored; warn if present. */
    legacyAiSettings: ["AI_PROVIDER", "ANTHROPIC_API_KEY", "AI_MODEL"].filter((k) => cleaned[k] !== undefined),
    auth: {
      requireEmailVerification: c.REQUIRE_EMAIL_VERIFICATION,
      sessionTtlMs: c.SESSION_TTL_HOURS * 3600 * 1000,
    },
    mail: { transport: c.MAIL_TRANSPORT, smtpUrl: c.SMTP_URL, from: c.MAIL_FROM },
    ocr: {
      enabled: c.OCR_ENABLED,
      langs: c.OCR_LANGS,
      cacheDir: c.OCR_CACHE_DIR,
      timeoutMs: c.OCR_TIMEOUT_MS,
    },
    uploadMaxBytes: c.UPLOAD_MAX_BYTES,
    rateLimitEnabled: c.RATE_LIMIT_ENABLED,
  };
}
