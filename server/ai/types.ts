import { z } from "zod";
import type { InputType } from "../detection/types.ts";

/** Categories the AI may use. Kept to the same vocabulary as the rule engine. */
export const AI_CATEGORIES = [
  "pressure", "credentials", "financial", "payment", "impersonation", "delivery", "account",
  "prize", "investment", "job", "phishing", "sender", "contextual",
] as const;

/**
 * Schema sent to the provider as the structured-output format. It is deliberately simple
 * (no length constraints) because providers support only a subset of JSON Schema;
 * limits are enforced afterwards by AiOutputValidationSchema.
 */
export const AiOutputSchema = z.object({
  indicators: z.array(
    z.object({
      category: z.enum(AI_CATEGORIES),
      severity: z.enum(["low", "medium", "high"]),
      description: z.string(),
      evidence: z.string(),
    }),
  ),
  summary: z.string(),
});

/** Strict validation applied to whatever the provider returns before it is used. */
export const AiOutputValidationSchema = z.object({
  indicators: z
    .array(
      z.object({
        category: z.enum(AI_CATEGORIES),
        severity: z.enum(["low", "medium", "high"]),
        description: z.string().trim().min(5).max(300),
        evidence: z.string().trim().min(3).max(200),
      }),
    )
    .max(10),
  summary: z.string().trim().max(800),
});

export type AiOutput = z.infer<typeof AiOutputValidationSchema>;

export interface AiRequest {
  type: InputType;
  content: string;
  /** Codes the rule engine already found, so the model can focus on additional context. */
  ruleIndicatorCodes: string[];
}

export type AiFailureKind = "timeout" | "rate_limited" | "refusal" | "invalid_output" | "auth" | "unavailable" | "bad_request";

export class AiProviderError extends Error {
  constructor(
    message: string,
    public readonly kind: AiFailureKind,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "AiProviderError";
  }
}

/** Strategy interface: any AI provider can be plugged in by implementing this. */
export interface AiProvider {
  readonly name: string;
  readonly model: string;
  /** Returns the provider's raw structured output. Validation happens in AiService. */
  analyze(request: AiRequest, signal: AbortSignal): Promise<unknown>;
}
