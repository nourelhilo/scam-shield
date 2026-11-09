import { clipEvidence, normalizeText } from "../detection/normalize.ts";
import type { Indicator } from "../detection/types.ts";
import { AiOutputValidationSchema, AiProviderError, type AiFailureKind, type AiProvider, type AiRequest } from "./types.ts";

export type AiStatus = "not_configured" | "used" | "failed" | "skipped";

export interface AiOutcome {
  status: AiStatus;
  provider: string | null;
  model: string | null;
  indicators: Indicator[];
  summary: string | null;
  /** AI indicators dropped because their evidence was not found in the submission. */
  rejectedIndicators: number;
  failureReason: AiFailureKind | "input_too_large" | null;
}

export interface AiServiceOptions {
  timeoutMs: number;
  maxRetries: number;
  maxInputChars: number;
  /** Privacy-aware logger: receives metadata only, never content. */
  log?: (event: Record<string, unknown>) => void;
}

const comparable = (value: string) => normalizeText(value).text.toLowerCase().replace(/\s+/g, " ").trim();

export class AiService {
  constructor(
    private readonly provider: AiProvider | null,
    private readonly options: AiServiceOptions,
  ) {}

  get configured() {
    return this.provider !== null;
  }

  get providerInfo() {
    return this.provider ? { provider: this.provider.name, model: this.provider.model } : null;
  }

  async analyze(request: AiRequest): Promise<AiOutcome> {
    const base = { provider: this.provider?.name ?? null, model: this.provider?.model ?? null, indicators: [], summary: null, rejectedIndicators: 0 };
    if (!this.provider) return { ...base, status: "not_configured", failureReason: null };
    // Never silently truncate: content over the AI limit is analysed by rules only.
    if (request.content.length > this.options.maxInputChars) {
      return { ...base, status: "skipped", failureReason: "input_too_large" };
    }

    const started = Date.now();
    let lastError: AiProviderError | null = null;
    for (let attempt = 0; attempt <= this.options.maxRetries; attempt++) {
      const remaining = this.options.timeoutMs - (Date.now() - started);
      if (remaining < 500) break;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), remaining);
      try {
        const raw = await raceAbort(this.provider.analyze(request, controller.signal), controller.signal);
        const outcome = this.validate(raw, request.content);
        this.options.log?.({ event: "ai_analysis", status: "used", attempt, ms: Date.now() - started, indicators: outcome.indicators.length, rejected: outcome.rejectedIndicators });
        return { ...base, ...outcome, status: "used", failureReason: null };
      } catch (error) {
        lastError =
          error instanceof AiProviderError
            ? error
            : controller.signal.aborted
              ? new AiProviderError("The AI provider timed out.", "timeout", true)
              : new AiProviderError("Unexpected AI error.", "unavailable", false);
        if (!lastError.retryable) break;
      } finally {
        clearTimeout(timer);
      }
    }
    const reason = lastError?.kind ?? "timeout";
    this.options.log?.({ event: "ai_analysis", status: "failed", reason, ms: Date.now() - started });
    return { ...base, status: "failed", failureReason: reason };
  }

  /** Validate provider output and keep only indicators whose evidence really occurs in the content. */
  private validate(raw: unknown, content: string): Pick<AiOutcome, "indicators" | "summary" | "rejectedIndicators"> {
    const parsed = AiOutputValidationSchema.safeParse(raw);
    if (!parsed.success) throw new AiProviderError("The AI response failed validation.", "invalid_output", false);

    const haystack = comparable(content);
    const indicators: Indicator[] = [];
    let rejected = 0;
    for (const item of parsed.data.indicators) {
      const evidence = comparable(item.evidence).replace(/…$/, "");
      if (evidence.length < 3 || !haystack.includes(evidence)) {
        rejected++;
        continue;
      }
      indicators.push({
        code: `AI_${item.category.toUpperCase()}`,
        category: item.category,
        severity: item.severity,
        description: item.description,
        evidence: clipEvidence(item.evidence),
        source: "ai",
      });
    }
    return { indicators, summary: parsed.data.summary || null, rejectedIndicators: rejected };
  }
}

/** Reject as soon as the signal aborts, even if the provider ignores the signal. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new AiProviderError("The AI provider timed out.", "timeout", true));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => (signal.removeEventListener("abort", onAbort), resolve(v)),
      (e) => (signal.removeEventListener("abort", onAbort), reject(e)),
    );
  });
}

/** Test/development double. Clearly not a real AI provider. */
export class StaticAiProvider implements AiProvider {
  readonly name = "static-test-double";
  readonly model = "none";
  constructor(private readonly respond: (request: AiRequest, signal: AbortSignal) => Promise<unknown>) {}
  analyze(request: AiRequest, signal: AbortSignal) {
    return this.respond(request, signal);
  }
}
