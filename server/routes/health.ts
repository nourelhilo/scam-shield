import type { FastifyInstance } from "fastify";

/** Public liveness/capability check. Reveals no versions, secrets, or internal state. */
export async function healthRoutes(app: FastifyInstance, options: {
  ping?: () => Promise<boolean>;
  mlAvailable: () => boolean;
  ocr: boolean;
}) {
  app.get("/api/health", async (_request, reply) => {
    const dbOk = await options.ping?.() ?? true;
    reply.header("Cache-Control", "no-store");
    return reply.status(dbOk ? 200 : 503).send({
      status: dbOk ? "ok" : "degraded",
      capabilities: {
        analysis: true,
        /** ScamShield's own ML classifier is loaded and ready. */
        ml: options.mlAvailable(),
        /** Deprecated: external AI was removed. Always false. */
        ai: false,
        ocr: options.ocr,
        accounts: Boolean(options.ping),
      },
    });
  });
}
