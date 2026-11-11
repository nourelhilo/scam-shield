import type { InputType, Language } from "../detection/types.ts";
import { MlEngineError, type EngineStatus, type MlEngine } from "./engine.ts";
import type { MlBand, Prediction, TermContribution } from "./linear-model.ts";

/**
 * ScamShield's own ML classifier, as seen by the analysis pipeline.
 *
 * The service decides whether the model applies, runs it through the engine with a hard
 * timeout, validates the output, and reports a truthful status. It never invents a
 * prediction: if inference does not complete, status is "unavailable" or "failed" and the
 * caller falls back to the rule-based engines.
 */
export type MlStatus = "used" | "not_applicable" | "unavailable" | "failed";

export type MlReason =
  | "input_type_url"
  | "insufficient_content"
  | "unsupported_language"
  | "input_too_large"
  | "disabled"
  | "model_unavailable"
  | "timeout"
  | "queue_full"
  | "engine_error"
  | "invalid_output";

export interface MlOutcome {
  status: MlStatus;
  reason: MlReason | null;
  modelVersion: string | null;
  probability: number | null;
  band: MlBand | null;
  label: "suspicious" | "legitimate" | null;
  truncated: boolean;
  latencyMs: number | null;
  explanation: { towardSuspicious: TermContribution[]; towardLegitimate: TermContribution[] } | null;
}

export interface MlRequest {
  type: InputType;
  /** Text the model should read (email: subject + body, without pasted headers). */
  text: string;
  language: Language;
  insufficientContent: boolean;
}

export interface MlServiceOptions {
  timeoutMs: number;
  maxInputChars: number;
  /** Metadata-only logger (status, reason, timing). Never receives content. */
  log?: (event: Record<string, unknown>) => void;
}

const SUPPORTED_LANGUAGES: ReadonlySet<Language> = new Set(["en"]);

const empty = (status: MlStatus, reason: MlReason | null, modelVersion: string | null): MlOutcome => ({
  status,
  reason,
  modelVersion,
  probability: null,
  band: null,
  label: null,
  truncated: false,
  latencyMs: null,
  explanation: null,
});

export class MlService {
  private readonly engine: MlEngine | null;
  private readonly options: MlServiceOptions;

  constructor(engine: MlEngine | null, options: MlServiceOptions) {
    this.engine = engine;
    this.options = options;
  }

  get enabled() {
    return this.engine !== null;
  }

  status(): EngineStatus | null {
    return this.engine?.status() ?? null;
  }

  get available() {
    return this.engine?.status().state === "ready";
  }

  info() {
    return this.engine?.info() ?? null;
  }

  /** Wait for the engine to finish loading (startup only). */
  async ready() {
    return this.engine ? this.engine.ready() : null;
  }

  get modelVersion() {
    return this.engine?.status().modelVersion ?? null;
  }

  async analyze(request: MlRequest): Promise<MlOutcome> {
    const version = this.modelVersion;
    if (request.type === "url") return empty("not_applicable", "input_type_url", version);
    if (request.insufficientContent) return empty("not_applicable", "insufficient_content", version);
    if (!SUPPORTED_LANGUAGES.has(request.language)) return empty("not_applicable", "unsupported_language", version);
    if (!this.engine) return empty("unavailable", "disabled", null);
    if (request.text.length > this.options.maxInputChars) return empty("not_applicable", "input_too_large", version);
    if (this.engine.status().state === "unavailable") return this.finish(empty("unavailable", "model_unavailable", null), 0);

    const started = performance.now();
    try {
      const prediction = await this.engine.predict(request.text, this.options.timeoutMs);
      if (!isValidPrediction(prediction)) return this.finish(empty("failed", "invalid_output", version), started);
      return this.finish(
        {
          status: "used",
          reason: null,
          modelVersion: prediction.modelVersion,
          probability: Math.round(prediction.probability * 10_000) / 10_000,
          band: prediction.band,
          label: prediction.label,
          truncated: prediction.truncated,
          latencyMs: null,
          explanation: { towardSuspicious: prediction.explanation.towardSuspicious, towardLegitimate: prediction.explanation.towardLegitimate },
        },
        started,
      );
    } catch (error) {
      const kind = error instanceof MlEngineError ? error.kind : "engine_error";
      const reason: MlReason = kind === "unavailable" ? "model_unavailable" : kind === "invalid_input" ? "input_too_large" : kind;
      return this.finish(empty(kind === "unavailable" ? "unavailable" : "failed", reason, version), started);
    }
  }

  private finish(outcome: MlOutcome, started: number): MlOutcome {
    const latencyMs = started ? Math.round((performance.now() - started) * 100) / 100 : null;
    this.options.log?.({ event: "ml_inference", status: outcome.status, reason: outcome.reason, band: outcome.band, ms: latencyMs, modelVersion: outcome.modelVersion });
    return { ...outcome, latencyMs };
  }

  async close() {
    await this.engine?.close();
  }
}

const BANDS = new Set(["low", "uncertain", "elevated", "strong"]);

function isTerms(value: unknown): value is TermContribution[] {
  return Array.isArray(value) && value.length <= 20 && value.every((t) => t && typeof t.term === "string" && typeof t.display === "string" && Number.isFinite(t.weight));
}

/** Defence in depth: never pass on a malformed or out-of-range prediction. */
export function isValidPrediction(p: unknown): p is Prediction {
  if (!p || typeof p !== "object") return false;
  const v = p as Prediction;
  return (
    typeof v.modelVersion === "string" &&
    Number.isFinite(v.probability) && v.probability >= 0 && v.probability <= 1 &&
    BANDS.has(v.band) &&
    (v.label === "suspicious" || v.label === "legitimate") &&
    (v.label === "suspicious") === v.probability >= 0.5 &&
    !!v.explanation && isTerms(v.explanation.towardSuspicious) && isTerms(v.explanation.towardLegitimate)
  );
}
