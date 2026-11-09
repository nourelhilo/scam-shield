import { z } from "zod";

export const MAX_CONTENT_CHARS = 10_000;

const EmailFields = z
  .object({
    from: z.string().max(320).optional(),
    replyTo: z.string().max(320).optional(),
    subject: z.string().max(998).optional(),
    body: z.string().max(MAX_CONTENT_CHARS).optional(),
  })
  .strict();

export const AnalyzeRequestSchema = z
  .object({
    type: z.enum(["text", "url", "email"]),
    content: z.string().max(MAX_CONTENT_CHARS, `Content must be ${MAX_CONTENT_CHARS.toLocaleString("en-US")} characters or fewer.`).default(""),
    /** Optional structured email fields (alternative to pasting the whole email into `content`). */
    email: EmailFields.optional(),
    /** Opt-in: save the result to the signed-in user's scan history. */
    save: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasContent = value.content.trim().length > 0;
    const hasEmailBody = Boolean(value.email?.body?.trim() || value.email?.subject?.trim());
    if (!hasContent && !(value.type === "email" && hasEmailBody)) {
      ctx.addIssue({ code: "custom", path: ["content"], message: "Content is required." });
    }
    if (value.email && value.type !== "email") {
      ctx.addIssue({ code: "custom", path: ["email"], message: "Email fields are only allowed when type is \"email\"." });
    }
    if (value.type === "url" && /\s/.test(value.content.trim())) {
      ctx.addIssue({ code: "custom", path: ["content"], message: "A link must not contain spaces." });
    }
  });

export type AnalyzeRequest = z.infer<typeof AnalyzeRequestSchema>;
