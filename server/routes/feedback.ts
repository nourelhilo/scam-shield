import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { RATE_LIMITS } from "../lib/limits.ts";
import { AppError, notFound, parseOrThrow } from "../lib/errors.ts";

const FeedbackSchema = z
  .object({
    feedbackType: z.enum(["false_positive", "missed_scam", "unclear_explanation", "other"]),
    /** Saved scan (signed-in users). Must belong to the caller. */
    scanId: z.string().uuid().optional(),
    /** analysisId from a POST /api/analyze response (works for guests too; not verifiable). */
    analysisId: z.string().uuid().optional(),
    reportedRiskLevel: z.enum(["low", "medium", "high", "unknown"]).optional(),
    comment: z.string().trim().max(1000).optional(),
  })
  .strict()
  .refine((v) => v.scanId || v.analysisId, { message: "Provide scanId or analysisId.", path: ["scanId"] });

const MAX_FEEDBACK_PER_USER_PER_HOUR = 20;

/** Remove ASCII control characters except tab, newline, and carriage return. */
function stripControlChars(value: string) {
  return [...value].filter((ch) => {
    const c = ch.charCodeAt(0);
    return c === 9 || c === 10 || c === 13 || (c >= 32 && c !== 127);
  }).join("");
}

/**
 * Feedback is stored for admin review. It is never used automatically to change detection
 * rules or results, because reports can be mistaken or malicious.
 */
export async function feedbackRoutes(app: FastifyInstance) {
  app.post("/api/feedback", { config: { rateLimit: RATE_LIMITS.feedback } }, async (request, reply) => {
    const body = parseOrThrow(FeedbackSchema, request.body);
    const userId = request.auth?.user.id ?? null;

    if (body.scanId) {
      if (!userId) throw new AppError(401, "UNAUTHORIZED", "Sign in to send feedback about a saved scan.");
      const scan = await app.ctx.repos.scans.findOwned(userId, body.scanId);
      if (!scan) throw notFound("Scan not found.");
    }
    if (userId && (await app.ctx.repos.feedback.countRecentByUser(userId, 60)) >= MAX_FEEDBACK_PER_USER_PER_HOUR) {
      throw new AppError(429, "RATE_LIMITED", "You have sent a lot of feedback recently. Try again later.");
    }

    // Strip control characters; the comment is plain text and must be rendered as text.
    const comment = stripControlChars(body.comment ?? "") || null;
    const row = await app.ctx.repos.feedback.create({
      user_id: userId,
      scan_id: body.scanId ?? null,
      analysis_id: body.analysisId ?? null,
      feedback_type: body.feedbackType,
      reported_risk_level: body.reportedRiskLevel ?? null,
      comment,
    });
    return reply.status(201).send({ feedbackId: row.id, status: "received" });
  });
}
