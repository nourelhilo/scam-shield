import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { RATE_LIMITS } from "../lib/limits.ts";
import { toPublicUser } from "../auth/auth-service.ts";
import { notFound, parseOrThrow } from "../lib/errors.ts";

export async function meRoutes(app: FastifyInstance) {
  app.get("/api/me", async (request) => {
    const ctx = await app.requireAuth(request);
    return { user: toPublicUser(ctx.user) };
  });

  app.patch("/api/me", async (request) => {
    const ctx = await app.requireAuth(request);
    const body = parseOrThrow(z.object({ displayName: z.string().trim().min(1).max(80).nullable() }).strict(), request.body);
    const user = await app.ctx.repos.users.updateProfile(ctx.user.id, body.displayName);
    if (!user) throw notFound("Account not found.");
    return { user: toPublicUser(user) };
  });

  /** Permanently delete the account and all of its saved scans, sessions, and feedback. */
  app.delete("/api/me", { config: { rateLimit: RATE_LIMITS.authStrict } }, async (request, reply) => {
    const ctx = await app.requireAuth(request);
    const body = parseOrThrow(z.object({ password: z.string().min(1).max(128) }).strict(), request.body);
    await app.ctx.auth.deleteAccount(ctx, body.password);
    return reply.status(204).send();
  });
}
