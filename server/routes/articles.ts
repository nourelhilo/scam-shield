import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { notFound, parseOrThrow } from "../lib/errors.ts";
import { ARTICLE_CATEGORIES, type ArticleRow } from "../repositories/index.ts";

export const ListArticlesQuery = z
  .object({
    category: z.enum(ARTICLE_CATEGORIES).optional(),
    language: z.enum(["en", "ar"]).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    offset: z.coerce.number().int().min(0).max(10_000).default(0),
  })
  .strict();

export function toArticleDto(a: ArticleRow, includeBody = true) {
  return {
    id: a.id,
    slug: a.slug,
    title: a.title,
    category: a.category,
    language: a.language,
    summary: a.summary,
    ...(includeBody ? { body: a.body } : {}),
    status: a.status,
    publishedAt: a.published_at ? new Date(a.published_at).toISOString() : null,
    updatedAt: new Date(a.updated_at).toISOString(),
  };
}

/** Public educational content. Only published articles are visible here. */
export async function articleRoutes(app: FastifyInstance) {
  app.get("/api/articles", async (request) => {
    const q = parseOrThrow(ListArticlesQuery, request.query);
    const { items, total } = await app.ctx.repos.articles.list({ ...q, includeDrafts: false });
    return { items: items.map((a) => toArticleDto(a, false)), total, limit: q.limit, offset: q.offset, categories: ARTICLE_CATEGORIES };
  });

  app.get("/api/articles/:idOrSlug", async (request) => {
    const { idOrSlug } = parseOrThrow(z.object({ idOrSlug: z.string().min(1).max(120) }), request.params);
    const article = await app.ctx.repos.articles.findBySlugOrId(idOrSlug, false);
    if (!article) throw notFound("Article not found.");
    return { article: toArticleDto(article) };
  });
}
