import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { RATE_LIMITS } from "../lib/limits.ts";
import { EmailSchema, PasswordSchema } from "../auth/auth-service.ts";
import { AppError, parseOrThrow } from "../lib/errors.ts";

const TokenSchema = z.string().trim().min(10).max(200);
const DisplayName = z.string().trim().min(1).max(80).nullable().optional();

const ACCEPTED = { status: "accepted", message: "If the details are valid, we have sent an email with next steps." } as const;

export async function authRoutes(app: FastifyInstance) {
  const { auth } = app.ctx;

  app.post("/api/auth/register", { config: { rateLimit: RATE_LIMITS.authStrict } }, async (request, reply) => {
    const body = parseOrThrow(z.object({ email: EmailSchema, password: PasswordSchema, displayName: DisplayName }).strict(), request.body);
    await auth.register(body);
    return reply.status(202).send(ACCEPTED);
  });

  app.post("/api/auth/login", { config: { rateLimit: RATE_LIMITS.authStrict } }, async (request) => {
    const body = parseOrThrow(z.object({ email: EmailSchema, password: z.string().min(1).max(128) }).strict(), request.body);
    const session = await auth.login({ ...body, userAgent: request.headers["user-agent"] ?? null });
    return { token: session.token, tokenType: "Bearer", expiresAt: session.expiresAt.toISOString(), user: session.user };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const ctx = await app.requireAuth(request);
    await auth.logout(ctx.sessionId);
    return reply.status(204).send();
  });

  app.post("/api/auth/logout-all", async (request, reply) => {
    const ctx = await app.requireAuth(request);
    await auth.logoutEverywhere(ctx.user.id);
    return reply.status(204).send();
  });

  app.post("/api/auth/verify-email", { config: { rateLimit: RATE_LIMITS.authStrict } }, async (request) => {
    const body = parseOrThrow(z.object({ token: TokenSchema }).strict(), request.body);
    await auth.verifyEmail(body.token);
    return { status: "verified" };
  });

  /** Link target from the verification email. Returns plain text so no frontend page is needed. */
  app.get("/api/auth/verify-email", { config: { rateLimit: RATE_LIMITS.authStrict } }, async (request, reply) => {
    const query = z.object({ token: TokenSchema }).safeParse(request.query);
    reply.type("text/plain; charset=utf-8").header("Cache-Control", "no-store");
    if (!query.success) return reply.status(400).send("This verification link is invalid.");
    try {
      await auth.verifyEmail(query.data.token);
      return "Your email address is verified. You can close this tab and sign in to ScamShield.";
    } catch (error) {
      if (error instanceof AppError) return reply.status(error.statusCode).send(error.message);
      throw error;
    }
  });

  app.post("/api/auth/resend-verification", { config: { rateLimit: RATE_LIMITS.emailSending } }, async (request, reply) => {
    const body = parseOrThrow(z.object({ email: EmailSchema }).strict(), request.body);
    await auth.resendVerification(body.email);
    return reply.status(202).send(ACCEPTED);
  });

  app.post("/api/auth/password-reset/request", { config: { rateLimit: RATE_LIMITS.emailSending } }, async (request, reply) => {
    const body = parseOrThrow(z.object({ email: EmailSchema }).strict(), request.body);
    await auth.requestPasswordReset(body.email);
    return reply.status(202).send(ACCEPTED);
  });

  app.post("/api/auth/password-reset/confirm", { config: { rateLimit: RATE_LIMITS.authStrict } }, async (request) => {
    const body = parseOrThrow(z.object({ token: TokenSchema, newPassword: PasswordSchema }).strict(), request.body);
    await auth.resetPassword(body.token, body.newPassword);
    return { status: "password_reset", message: "Your password was changed. Sign in with the new password." };
  });

  app.post("/api/auth/change-password", { config: { rateLimit: RATE_LIMITS.authStrict } }, async (request) => {
    const ctx = await app.requireAuth(request);
    const body = parseOrThrow(z.object({ currentPassword: z.string().min(1).max(128), newPassword: PasswordSchema }).strict(), request.body);
    await auth.changePassword(ctx, body.currentPassword, body.newPassword);
    return { status: "password_changed", message: "Password changed. Other sessions were signed out." };
  });
}
