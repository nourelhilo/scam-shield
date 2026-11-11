import type { Indicator, InputType, RiskLevel } from "../detection/types.ts";
import type { MlOutcome, MlReason } from "../ml/ml-service.ts";
import type { RiskAssessment } from "./risk-engine.ts";

/**
 * Hybrid decision: combines the rule-based assessment (text rules + URL checks + email
 * sender checks, scored by risk-engine.ts) with ScamShield's ML classifier.
 *
 * The two signals are NOT averaged. The rule level is the anchor because every rule
 * indicator carries concrete evidence. The ML band then adjusts it within strict limits:
 *
 *   ML band      rule LOW                          rule MEDIUM   rule HIGH
 *   strong       MEDIUM                            HIGH          HIGH
 *   elevated     MEDIUM if >= 1 rule indicator     MEDIUM        HIGH
 *                (else LOW)
 *   uncertain    LOW                               MEDIUM        HIGH
 *   low          LOW                               MEDIUM        HIGH
 *
 *  - ML can raise the level by at most one step and never lowers it (a low ML score is not
 *    evidence of safety; disagreement is reported instead).
 *  - HIGH always requires rule-based MEDIUM first, so a statistical score or a single
 *    keyword can never produce HIGH on its own.
 *  - UNKNOWN when the input could not be analysed, when there is too little content, or when
 *    the ML model could not run (failure / unsupported language) AND the rules found nothing:
 *    the absence of rule findings alone is not treated as evidence of safety.
 *  - URLs are assessed by the URL engine only (the text model was not trained on bare URLs).
 *
 * POLICY.mlOnlyCanRaise: whether a "strong" ML score with ZERO rule indicators may raise
 * LOW to MEDIUM. Chosen on the VALIDATION split with server/scripts/evaluate-hybrid.ts
 * (never on test): with it, flagged-recall 0.924 at FPR 0.83%; without it, recall 0.408 at
 * FPR 0.62%, because the rules alone catch few of the public-dataset spam/phishing
 * messages. Cost: legitimate automated notifications the model over-scores can show MEDIUM
 * (see docs/MODEL_LIMITATIONS.md). It never yields HIGH.
 */
export interface HybridPolicy {
  mlOnlyCanRaise: boolean;
}

export const DEFAULT_HYBRID_POLICY: HybridPolicy = { mlOnlyCanRaise: true };

export type UnknownReason = "unanalyzable" | "insufficient_content" | "ml_unavailable" | "unsupported_language";

export interface HybridDecision {
  riskLevel: RiskLevel;
  ruleRiskLevel: RiskLevel;
  adjustment: "none" | "raised_by_ml" | "unknown_without_ml";
  agreement: "agree" | "ml_more_suspicious" | "ml_less_suspicious" | "ml_not_used";
  /** Plain-language trace of how the level was reached (no content). */
  reasons: string[];
  /** Present when the ML score is elevated or strong. Shown as a warning sign; not scored by the rule engine. */
  mlIndicator: Indicator | null;
  unknownReason: UnknownReason | null;
}

export interface HybridInput {
  inputType: InputType;
  ruleIndicators: Indicator[];
  rule: RiskAssessment;
  ml: MlOutcome;
  insufficientContent: boolean;
  unanalyzable: boolean;
}

const ML_FAILURE_REASONS: ReadonlySet<MlReason> = new Set(["disabled", "model_unavailable", "timeout", "queue_full", "engine_error", "invalid_output", "input_too_large"]);
const STEP_UP: Record<RiskLevel, RiskLevel> = { low: "medium", medium: "high", high: "high", unknown: "unknown" };

export const ML_INDICATOR_CODE = "ML_SCAM_LIKE_WORDING";

export function mlIndicator(ml: MlOutcome): Indicator | null {
  if (ml.status !== "used" || (ml.band !== "strong" && ml.band !== "elevated")) return null;
  const terms = (ml.explanation?.towardSuspicious ?? []).slice(0, 5).map((t) => t.display);
  return {
    code: ML_INDICATOR_CODE,
    category: "statistical",
    severity: ml.band === "strong" ? "medium" : "low",
    description:
      ml.band === "strong"
        ? "ScamShield's machine-learning model found the wording very similar to spam, phishing, and scam messages it was trained on. This is a statistical resemblance, not proof."
        : "ScamShield's machine-learning model found the wording somewhat similar to spam, phishing, and scam messages it was trained on. This is a statistical resemblance, not proof.",
    evidence: terms.length > 0 ? `words that weighed most: ${terms.join(", ")}` : "overall wording",
    source: "ml",
  };
}

export function combineSignals(input: HybridInput, policy: HybridPolicy = DEFAULT_HYBRID_POLICY): HybridDecision {
  const { rule, ml, ruleIndicators } = input;
  const base = { ruleRiskLevel: rule.riskLevel, mlIndicator: mlIndicator(ml) };

  if (input.unanalyzable) {
    return { ...base, riskLevel: "unknown", adjustment: "none", agreement: "ml_not_used", reasons: ["The input could not be analysed."], unknownReason: "unanalyzable" };
  }
  if (rule.riskLevel === "unknown") {
    return { ...base, riskLevel: "unknown", adjustment: "none", agreement: "ml_not_used", reasons: ["There was not enough content to assess."], unknownReason: "insufficient_content" };
  }

  if (ml.status !== "used") {
    const nothingFound = ruleIndicators.length === 0 && rule.riskLevel === "low";
    const mlCouldNotRun = ml.reason === "unsupported_language" || (ml.reason !== null && ML_FAILURE_REASONS.has(ml.reason));
    if (input.inputType !== "url" && nothingFound && mlCouldNotRun) {
      return {
        ...base,
        riskLevel: "unknown",
        adjustment: "unknown_without_ml",
        agreement: "ml_not_used",
        reasons: [
          ml.reason === "unsupported_language"
            ? "The machine-learning model does not support this language yet, and the rules found no warning signs."
            : "The machine-learning model could not run, and the rules found no warning signs.",
        ],
        unknownReason: ml.reason === "unsupported_language" ? "unsupported_language" : "ml_unavailable",
      };
    }
    return {
      ...base,
      riskLevel: rule.riskLevel,
      adjustment: "none",
      agreement: "ml_not_used",
      reasons: [input.inputType === "url" ? "Links are assessed by the URL checks only." : "Rule-based assessment only (the machine-learning model did not run)."],
      unknownReason: null,
    };
  }

  const band = ml.band!;
  const hasRuleEvidence = ruleIndicators.length > 0;
  let riskLevel: RiskLevel = rule.riskLevel;
  const reasons = [`Rules: ${rule.riskLevel} (${ruleIndicators.length} indicator${ruleIndicators.length === 1 ? "" : "s"}). Model: ${band} (p=${ml.probability}).`];

  if (band === "strong") {
    if (rule.riskLevel !== "low" || hasRuleEvidence || policy.mlOnlyCanRaise) riskLevel = STEP_UP[rule.riskLevel];
    else reasons.push("A strong model score alone does not raise the level without a rule-based warning sign.");
  } else if (band === "elevated" && rule.riskLevel === "low" && hasRuleEvidence) {
    riskLevel = "medium";
  }

  const mlSuspicious = band === "strong" || band === "elevated";
  const rulesSuspicious = rule.riskLevel === "medium" || rule.riskLevel === "high";
  const agreement = mlSuspicious === rulesSuspicious ? "agree" : mlSuspicious ? "ml_more_suspicious" : "ml_less_suspicious";
  if (riskLevel !== rule.riskLevel) reasons.push(`The model score raised the level from ${rule.riskLevel} to ${riskLevel}.`);
  if (agreement === "ml_less_suspicious") reasons.push("The model did not find the wording scam-like, but rule-based warning signs are kept: a low model score is not proof of safety.");

  return { ...base, riskLevel, adjustment: riskLevel !== rule.riskLevel ? "raised_by_ml" : "none", agreement, reasons, unknownReason: null };
}

/** Exposed for documentation/tests: the level transition table above. */
export const HYBRID_STEP_UP = STEP_UP;
