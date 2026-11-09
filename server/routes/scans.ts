import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { notFound, parseOrThrow } from "../lib/errors.ts";
import { renderTextReport, toScanDto } from "../reports/report.ts";

const IdParams = z.object({ id: z.string().uuid("Invalid scan id.") });

const ListQuery = z
  .object({
    riskLevel: z.enum(["low", "medium", "high", "unknown"]).optional(),
    from: z.string().datetime({ offset: true }).or(z.string().date()).optional(),
    to: z.string().datetime({ offset: true }).or(z.string().date()).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).max(100_000).default(0),
  })
  .strict();

/** Date-only `to` values include the whole day. */
function toDate(value: string | undefined, endOfDay: boolean) {
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`);
  return new Date(value);
}

/** Scan history. Every query is scoped to the signed-in user in SQL; other users' scans return 404. */
export async function scanRoutes(app: FastifyInstance) {
  const { scans } = app.ctx.repos;

  app.get("/api/scans", async (request) => {
    const ctx = await app.requireAuth(request);
    const q = parseOrThrow(ListQuery, request.query);
    const { items, total } = await scans.list(ctx.user.id, {
      riskLevel: q.riskLevel,
      from: toDate(q.from, false),
      to: toDate(q.to, true),
      limit: q.limit,
      offset: q.offset,
    });
    return { items: items.map(toScanDto), total, limit: q.limit, offset: q.offset };
  });

  app.get("/api/scans/:id", async (request) => {
    const ctx = await app.requireAuth(request);
    const { id } = parseOrThrow(IdParams, request.params);
    const scan = await scans.findOwned(ctx.user.id, id);
    if (!scan) throw notFound("Scan not found.");
    return { scan: toScanDto(scan) };
  });

  app.get("/api/scans/:id/report", async (request, reply) => {
    const ctx = await app.requireAuth(request);
    const { id } = parseOrThrow(IdParams, request.params);
    const { format } = parseOrThrow(z.object({ format: z.enum(["txt", "json"]).default("txt") }).strict(), request.query);
    const scan = await scans.findOwned(ctx.user.id, id);
    if (!scan) throw notFound("Scan not found.");
    reply.header("Cache-Control", "no-store").header("Content-Disposition", `attachment; filename="scamshield-report-${scan.id}.${format}"`);
    if (format === "json") return reply.type("application/json").send(JSON.stringify({ report: toScanDto(scan) }, null, 2));
    return reply.type("text/plain; charset=utf-8").send(renderTextReport(scan));
  });

  app.delete("/api/scans/:id", async (request, reply) => {
    const ctx = await app.requireAuth(request);
    const { id } = parseOrThrow(IdParams, request.params);
    const deleted = await scans.deleteOwned(ctx.user.id, id);
    if (!deleted) throw notFound("Scan not found.");
    return reply.status(204).send();
  });

  app.delete("/api/scans", async (request) => {
    const ctx = await app.requireAuth(request);
    const deleted = await scans.deleteAllOwned(ctx.user.id);
    return { deleted };
  });
}
