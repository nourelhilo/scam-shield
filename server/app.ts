import { randomUUID } from "node:crypto";
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import { AnalysisService } from "./analysis/analysis-service.ts";
import { AuthService, type AuthContext } from "./auth/auth-service.ts";
import type { Mailer } from "./auth/mailer.ts";
import type { AppConfig } from "./config.ts";
import type { Database } from "./db/database.ts";
import { AppError, forbidden, unauthorized } from "./lib/errors.ts";
import type { MlService } from "./ml/ml-service.ts";
export { RATE_LIMITS } from "./lib/limits.ts";
import type { OcrService } from "./ocr/ocr-service.ts";
import { createRepositories, type Repositories } from "./repositories/index.ts";
import { adminRoutes } from "./routes/admin.ts";
import { analyzeRoutes, textAnalysisRoutes } from "./routes/analyze.ts";
import { articleRoutes } from "./routes/articles.ts";
import { authRoutes } from "./routes/auth.ts";
import { feedbackRoutes } from "./routes/feedback.ts";
import { frontendRoutes } from "./routes/frontend.ts";
import { healthRoutes } from "./routes/health.ts";
import { meRoutes } from "./routes/me.ts";
import { scanRoutes } from "./routes/scans.ts";

export interface AppDependencies {
  config: AppConfig;
  db: Database;
  mailer: Mailer;
  /** ScamShield's own ML classifier (local inference). */
  ml: MlService;
  ocr: OcrService;
}

export interface AppContext extends AppDependencies {
  repos: Repositories;
  auth: AuthService;
  analysis: AnalysisService;
  startedAt: Date;
}

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
  interface FastifyInstance {
    ctx: AppContext;
    requireAuth: (request: FastifyRequest) => Promise<AuthContext>;
    requireAdmin: (request: FastifyRequest) => Promise<AuthContext>;
  }
}

export const JSON_BODY_LIMIT = 64 * 1024;

function bearerToken(request: FastifyRequest) {
  const header = request.headers.authorization;
  if (!header) return null;
  const match = header.match(/^Bearer\s+(\S+)$/i);
  return match ? match[1]! : "";
}

async function buildHttpApp(config: AppConfig) {
  const app = Fastify({
    bodyLimit: JSON_BODY_LIMIT,
    trustProxy: config.trustProxy,
    genReqId: () => randomUUID(),
    logger: {
      level: config.logLevel,
      // Privacy: never log bodies, auth headers, cookies, or query strings (which may hold tokens).
      redact: { paths: ["req.headers.authorization", "req.headers.cookie", "res.headers['set-cookie']"], censor: "[redacted]" },
      serializers: {
        req: (req: FastifyRequest) => ({ id: req.id, method: req.method, url: req.url.split("?")[0], ip: req.ip }),
      },
    },
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: config.isProd ? [] : null,
      },
    },
    strictTransportSecurity: config.isProd ? { maxAge: 15552000, includeSubDomains: true } : false,
    crossOriginEmbedderPolicy: false,
  });

  await app.register(cors, {
    origin: (origin, cb) => {
      // Same-origin and non-browser requests have no Origin header.
      if (!origin) return cb(null, true);
      cb(null, config.corsOrigins.includes(origin));
    },
    methods: ["GET", "POST", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization", "Accept"],
    exposedHeaders: ["Content-Disposition", "Retry-After", "X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset"],
    credentials: false,
    maxAge: 600,
  });

  await app.register(rateLimit, {
    global: true,
    max: 120,
    timeWindow: "1 minute",
    enableDraftSpec: false,
    skipOnError: false,
    allowList: () => !config.rateLimitEnabled,
    errorResponseBuilder: (_req, context) => ({
      statusCode: 429,
      error: { code: "RATE_LIMITED", message: "Too many requests. Wait a moment, then try again.", details: { retryAfterSeconds: Math.ceil(context.ttl / 1000) } },
    }),
  });

  app.setErrorHandler((error: FastifyError | AppError, request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({ error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } });
    }
    const status = error.statusCode ?? 500;
    if (status === 429) {
      const body = error as unknown as { error?: unknown };
      return reply.status(429).send(body.error ? body : { error: { code: "RATE_LIMITED", message: "Too many requests. Wait a moment, then try again." } });
    }
    if (status === 413 || error.code === "FST_REQ_FILE_TOO_LARGE" || error.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      return reply.status(413).send({ error: { code: "PAYLOAD_TOO_LARGE", message: "The request is too large." } });
    }
    if (error.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
      return reply.status(415).send({ error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "Send JSON with Content-Type: application/json." } });
    }
    if (status >= 400 && status < 500) {
      return reply.status(status).send({ error: { code: "BAD_REQUEST", message: "The request could not be processed." } });
    }
    request.log.error({ err: { message: error.message, code: error.code, stack: error.stack } }, "unhandled error");
    return reply.status(500).send({ error: { code: "INTERNAL_ERROR", message: "Something went wrong on our side. Try again later." } });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({ error: { code: "NOT_FOUND", message: `No route for ${request.method} ${request.url.split("?")[0]}.` } });
  });

  return app;
}

export async function buildAnalyzerApp(config: AppConfig, ml: MlService) {
  const app = await buildHttpApp(config);
  await app.register(healthRoutes, { mlAvailable: () => ml.available, ocr: false });
  await app.register(textAnalysisRoutes, { analysis: new AnalysisService({ ml }) });
  if (config.serveFrontend) await app.register(frontendRoutes, { accounts: false });
  app.addHook("onClose", () => ml.close());
  return app;
}

export async function buildApp(deps: AppDependencies): Promise<FastifyInstance> {
  const { config } = deps;
  const app = await buildHttpApp(config);
  const repos = createRepositories(deps.db);
  const ctx: AppContext = {
    ...deps,
    repos,
    auth: new AuthService(repos, deps.mailer, {
      publicAppUrl: config.publicAppUrl,
      sessionTtlMs: config.auth.sessionTtlMs,
      requireEmailVerification: config.auth.requireEmailVerification,
    }),
    analysis: new AnalysisService({ ml: deps.ml, recordStats: (s) => repos.stats.increment(s) }),
    startedAt: new Date(),
  };
  app.decorate("ctx", ctx);
  app.decorateRequest("auth", null);

  await app.register(multipart, {
    limits: { fileSize: config.uploadMaxBytes, files: 1, fields: 5, fieldSize: 1024, parts: 6, headerPairs: 50 },
  });

  // Resolve the optional bearer session on every request; routes decide whether it is required.
  app.addHook("onRequest", async (request) => {
    const token = bearerToken(request);
    if (token === null) return;
    if (token === "") throw unauthorized("Malformed Authorization header.");
    request.auth = await ctx.auth.authenticate(token);
  });

  app.decorate("requireAuth", async (request: FastifyRequest) => {
    if (!request.auth) throw unauthorized();
    return request.auth;
  });
  app.decorate("requireAdmin", async (request: FastifyRequest) => {
    if (!request.auth) throw unauthorized();
    if (request.auth.user.role !== "admin") throw forbidden("Administrator access is required.");
    return request.auth;
  });

  await app.register(healthRoutes, {
    ping: () => deps.db.ping(),
    mlAvailable: () => deps.ml.available,
    ocr: deps.ocr.enabled,
  });
  await app.register(analyzeRoutes);
  await app.register(authRoutes);
  await app.register(meRoutes);
  await app.register(scanRoutes);
  await app.register(feedbackRoutes);
  await app.register(articleRoutes);
  await app.register(adminRoutes);
  if (config.serveFrontend) await app.register(frontendRoutes);

  return app;
}
