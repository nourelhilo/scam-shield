import type { FastifyInstance } from "fastify";

/** Public liveness/capability check. Reveals no versions, secrets, or internal state. */
export async function healthRoutes(app: FastifyInstance) {
  app.get("/api/health", async (_request, reply) => {
    const dbOk = await app.ctx.db.ping();
    reply.header("Cache-Control", "no-store");
    return reply.status(dbOk ? 200 : 503).send({
      status: dbOk ? "ok" : "degraded",
      capabilities: {
        analysis: true,
        /** ScamShield's own ML classifier is loaded and ready. */
        ml: app.ctx.ml.available,
        /** Deprecated: external AI was removed. Always false. */
        ai: false,
        ocr: app.ctx.ocr.enabled,
        accounts: true,
      },
    });
  });
}
