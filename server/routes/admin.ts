import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { EMAIL_RULE_DEFINITIONS } from "../detection/email-analyzer.ts";
import { TEXT_RULE_DEFINITIONS } from "../detection/text-rules.ts";
import { URL_RULE_DEFINITIONS } from "../detection/url-analyzer.ts";
import { AppError, notFound, parseOrThrow } from "../lib/errors.ts";
import { ARTICLE_CATEGORIES } from "../repositories/index.ts";
import { ListArticlesQuery, toArticleDto } from "./articles.ts";

const IdParams = z.object({ id: z.string().uuid() });
const Slug = z.string().trim().min(3).max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, numbers, and hyphens.");
const ArticleFields = {
  slug: Slug,
  title: z.string().trim().min(3).max(200),
  category: z.enum(ARTICLE_CATEGORIES),
  language: z.enum(["en", "ar"]),
  summary: z.string().trim().min(10).max(500),
  body: z.string().trim().min(20).max(20_000),
};

/**
 * Admin API. Every route calls requireAdmin (server-side role check from the database).
 * Analytics are aggregate counts only and never include submitted content or user ids.
 */
export async function adminRoutes(app: FastifyInstance) {
  const { repos } = app.ctx;

  app.addHook("preHandler", async (request) => {
    if (request.url.startsWith("/api/admin/") || request.url === "/api/admin") await app.requireAdmin(request);
  });

  app.get("/api/admin/metrics", async (request) => {
    const { days } = parseOrThrow(z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }).strict(), request.query);
    const [daily, users, savedScans, feedback] = await Promise.all([
      repos.stats.summary(days),
      repos.users.count(),
      repos.scans.count(),
      repos.feedback.summary(),
    ]);
    const totals = { analyses: 0, byRiskLevel: {} as Record<string, number>, byInputType: {} as Record<string, number>, byMethod: {} as Record<string, number> };
    for (const row of daily) {
      totals.analyses += row.count;
      totals.byRiskLevel[row.risk_level] = (totals.byRiskLevel[row.risk_level] ?? 0) + row.count;
      totals.byInputType[row.input_type] = (totals.byInputType[row.input_type] ?? 0) + row.count;
      totals.byMethod[row.analysis_method] = (totals.byMethod[row.analysis_method] ?? 0) + row.count;
    }
    return {
      periodDays: days,
      totals,
      daily: daily.map((r) => ({ day: r.day, inputType: r.input_type, riskLevel: r.risk_level, analysisMethod: r.analysis_method, count: r.count })),
      users,
      savedScans,
      feedback,
    };
  });

  app.get("/api/admin/health", async () => {
    const dbOk = await app.ctx.db.ping();
    return {
      status: dbOk ? "ok" : "degraded",
      uptimeSeconds: Math.round((Date.now() - app.ctx.startedAt.getTime()) / 1000),
      environment: app.ctx.config.env,
      database: { kind: app.ctx.db.kind, reachable: dbOk },
      ai: app.ctx.ai.providerInfo ? { configured: true, ...app.ctx.ai.providerInfo } : { configured: false },
      ocr: { enabled: app.ctx.ocr.enabled },
      mail: { transport: app.ctx.config.mail.transport },
      rateLimiting: { enabled: app.ctx.config.rateLimitEnabled, store: "in-memory (per process)" },
      node: process.version,
    };
  });

  app.get("/api/admin/rules", async () => ({
    text: TEXT_RULE_DEFINITIONS,
    url: URL_RULE_DEFINITIONS,
    email: EMAIL_RULE_DEFINITIONS,
  }));

  app.get("/api/admin/feedback", async (request) => {
    const q = parseOrThrow(
      z.object({
        status: z.enum(["open", "reviewed", "dismissed"]).optional(),
        type: z.enum(["false_positive", "missed_scam", "unclear_explanation", "other"]).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      }).strict(),
      request.query,
    );
    const { items, total } = await repos.feedback.list(q);
    return {
      items: items.map((f) => ({
        id: f.id,
        feedbackType: f.feedback_type,
        reportedRiskLevel: f.reported_risk_level,
        comment: f.comment,
        status: f.status,
        hasAccount: f.user_id !== null,
        scanId: f.scan_id,
        analysisId: f.analysis_id,
        reviewedAt: f.reviewed_at ? new Date(f.reviewed_at).toISOString() : null,
        createdAt: new Date(f.created_at).toISOString(),
      })),
      total,
    };
  });

  app.patch("/api/admin/feedback/:id", async (request) => {
    const admin = await app.requireAdmin(request);
    const { id } = parseOrThrow(IdParams, request.params);
    const { status } = parseOrThrow(z.object({ status: z.enum(["open", "reviewed", "dismissed"]) }).strict(), request.body);
    const row = await repos.feedback.setStatus(id, status, admin.user.id);
    if (!row) throw notFound("Feedback not found.");
    await repos.audit.record({ actorId: admin.user.id, action: "feedback.status_changed", targetType: "feedback", targetId: id, metadata: { status } });
    return { id: row.id, status: row.status };
  });

  app.get("/api/admin/articles", async (request) => {
    const q = parseOrThrow(ListArticlesQuery, request.query);
    const { items, total } = await repos.articles.list({ ...q, includeDrafts: true });
    return { items: items.map((a) => toArticleDto(a, false)), total };
  });

  app.get("/api/admin/articles/:id", async (request) => {
    const { id } = parseOrThrow(IdParams, request.params);
    const article = await repos.articles.findBySlugOrId(id, true);
    if (!article) throw notFound("Article not found.");
    return { article: toArticleDto(article) };
  });

  app.post("/api/admin/articles", async (request, reply) => {
    const admin = await app.requireAdmin(request);
    const body = parseOrThrow(z.object({ ...ArticleFields, status: z.enum(["draft", "published"]).default("draft") }).strict(), request.body);
    const article = await repos.articles.create({ ...body, createdBy: admin.user.id });
    if (!article) throw new AppError(409, "SLUG_TAKEN", "An article with this slug already exists.");
    await repos.audit.record({ actorId: admin.user.id, action: "article.created", targetType: "article", targetId: article.id, metadata: { slug: article.slug, status: article.status } });
    return reply.status(201).send({ article: toArticleDto(article) });
  });

  app.patch("/api/admin/articles/:id", async (request) => {
    const admin = await app.requireAdmin(request);
    const { id } = parseOrThrow(IdParams, request.params);
    const patch = parseOrThrow(
      z.object(ArticleFields).partial().strict().refine((v) => Object.keys(v).length > 0, "Provide at least one field to update."),
      request.body,
    );
    let article;
    try {
      article = await repos.articles.update(id, patch);
    } catch (error) {
      if ((error as { code?: string }).code === "23505") throw new AppError(409, "SLUG_TAKEN", "An article with this slug already exists.");
      throw error;
    }
    if (!article) throw notFound("Article not found.");
    await repos.audit.record({ actorId: admin.user.id, action: "article.updated", targetType: "article", targetId: id, metadata: { fields: Object.keys(patch) } });
    return { article: toArticleDto(article) };
  });

  for (const [path, status] of [["publish", "published"], ["unpublish", "draft"]] as const) {
    app.post(`/api/admin/articles/:id/${path}`, async (request) => {
      const admin = await app.requireAdmin(request);
      const { id } = parseOrThrow(IdParams, request.params);
      const article = await repos.articles.setStatus(id, status);
      if (!article) throw notFound("Article not found.");
      await repos.audit.record({ actorId: admin.user.id, action: `article.${path}ed`, targetType: "article", targetId: id });
      return { article: toArticleDto(article) };
    });
  }

  app.delete("/api/admin/articles/:id", async (request, reply) => {
    const admin = await app.requireAdmin(request);
    const { id } = parseOrThrow(IdParams, request.params);
    if (!(await repos.articles.delete(id))) throw notFound("Article not found.");
    await repos.audit.record({ actorId: admin.user.id, action: "article.deleted", targetType: "article", targetId: id });
    return reply.status(204).send();
  });

  app.get("/api/admin/audit-logs", async (request) => {
    const q = parseOrThrow(z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) }).strict(), request.query);
    return { items: await repos.audit.list(q.limit, q.offset) };
  });
}
