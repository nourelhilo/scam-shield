import { randomUUID } from "node:crypto";
import { runDetection } from "../detection/detect.ts";
import type { Indicator, InputType, Language, RiskLevel } from "../detection/types.ts";
import type { TermContribution } from "../ml/linear-model.ts";
import type { MlOutcome, MlReason, MlService, MlStatus } from "../ml/ml-service.ts";
import { buildExplanation, buildRecommendations } from "../risk/explain.ts";
import { combineSignals, DEFAULT_HYBRID_POLICY, type HybridDecision } from "../risk/hybrid.ts";
import { assessRisk } from "../risk/risk-engine.ts";
import type { AnalyzeRequest } from "./schemas.ts";

/** "rules" = rule/URL/email engines only; "rules+ml" = those plus ScamShield's own ML classifier. */
export type AnalysisMethod = "rules" | "rules+ml";

export interface MlPrediction {
  status: MlStatus;
  reason: MlReason | null;
  modelVersion: string | null;
  /** Model score for the "suspicious" class (0-1). Not a calibrated real-world scam probability. */
  probability: number | null;
  band: MlOutcome["band"];
  label: MlOutcome["label"];
  decisionThreshold: 0.5;
  truncated: boolean;
  latencyMs: number | null;
  interpretation: string;
}

export interface ModelExplanation {
  method: "linear_term_contributions";
  /** Normalised words from the submission that pushed the score toward "suspicious", strongest first. */
  towardSuspicious: TermContribution[];
  /** Normalised words that pushed the score toward "legitimate". */
  towardLegitimate: TermContribution[];
  note: string;
}

export interface AnalysisResult {
  analysisId: string;
  status: "completed";
  inputType: InputType | "image";
  riskLevel: RiskLevel;
  /** Alias of riskLevel, kept for the existing frontend contract (checker.js). */
  risk: RiskLevel;
  /** Alias of explanation, kept for the existing frontend contract (checker.js). */
  summary: string;
  explanation: string;
  /** Human-readable indicator lines, kept for the existing frontend contract (checker.js). */
  warnings: string[];
  /** Every warning sign shown to the user: rule indicators plus, when present, the ML indicator. */
  indicators: Indicator[];
  /** Rule, URL, and email-sender indicators only (each with evidence from the submission). */
  ruleIndicators: Indicator[];
  recommendations: string[];
  analysisMethod: AnalysisMethod;
  modelVersion: string | null;
  mlPrediction: MlPrediction;
  modelExplanation: ModelExplanation | null;
  hybrid: Pick<HybridDecision, "ruleRiskLevel" | "adjustment" | "agreement" | "reasons"> & { mlOnlyCanRaise: boolean };
  /**
   * DEPRECATED. External AI analysis was removed; this object is kept so older clients that
   * read it do not break. It always reports that no external AI was used.
   */
  ai: { status: "not_configured"; provider: null; model: null; summary: null; reason: "external_ai_removed" };
  language: Language;
  email?: { senderVerified: false; fromAddress: string | null; note: string };
  disclaimer: string;
  saved: boolean;
  scanId: string | null;
  createdAt: string;
}

export const DISCLAIMER =
  "ScamShield gives an automated risk estimate based on known warning signs and its own machine-learning model. It cannot guarantee that something is safe or prove that it is fraudulent. Verify unexpected requests through an official channel.";

const EMAIL_NOTE =
  "Sender details were pasted by you and cannot be verified. Email authentication (SPF, DKIM, DMARC) was not checked.";

const EXPLANATION_NOTE =
  "These are the words (after normalisation: lower-case, digits shown as #, links as [link]) that moved the model's score most. They show what the model reacted to, not proof that the message is fraudulent. The model also uses character patterns inside words, which are folded into these word scores.";

const DEPRECATED_AI = { status: "not_configured", provider: null, model: null, summary: null, reason: "external_ai_removed" } as const;

function interpretation(ml: MlOutcome): string {
  switch (ml.status) {
    case "used":
      return `The model scored this text ${ml.probability} on a 0-1 scale for resemblance to the spam, phishing, and smishing examples it was trained on (band: ${ml.band}). This is a statistical score, not a calibrated probability that the message is a scam.`;
    case "not_applicable":
      return ml.reason === "unsupported_language"
        ? "The machine-learning model was trained on English text only, so it was not applied. The rule-based checks still ran."
        : ml.reason === "input_type_url"
          ? "Links are assessed by the URL checks; the text model was not applied."
          : "The machine-learning model was not applied to this input.";
    case "unavailable":
      return "The machine-learning model is unavailable, so only the rule-based checks ran.";
    case "failed":
    default:
      return "The machine-learning model did not return a result in time, so only the rule-based checks ran.";
  }
}

export interface AnalysisDependencies {
  ml: MlService;
  /** Called with anonymous counts only (no content, no user id). Failures are ignored. */
  recordStats?: (stat: { inputType: string; riskLevel: RiskLevel; analysisMethod: AnalysisMethod }) => Promise<void>;
}

export class AnalysisService {
  constructor(private readonly deps: AnalysisDependencies) {}

  async analyze(request: Pick<AnalyzeRequest, "type" | "content" | "email">, inputTypeOverride?: "image"): Promise<AnalysisResult> {
    const detection = runDetection({ type: request.type, content: request.content, email: request.email });
    const ruleIndicators = detection.indicators;

    const ml = detection.unanalyzable
      ? ({ status: "not_applicable", reason: "input_type_url", modelVersion: null, probability: null, band: null, label: null, truncated: false, latencyMs: null, explanation: null } satisfies MlOutcome)
      : await this.deps.ml.analyze({ type: request.type, text: detection.modelText, language: detection.language, insufficientContent: detection.insufficientContent });

    const ruleAssessment = assessRisk(ruleIndicators, {
      inputType: request.type,
      insufficientContent: detection.insufficientContent,
      unanalyzable: detection.unanalyzable,
    });
    const decision = combineSignals(
      { inputType: request.type, ruleIndicators, rule: ruleAssessment, ml, insufficientContent: detection.insufficientContent, unanalyzable: detection.unanalyzable },
      DEFAULT_HYBRID_POLICY,
    );

    const indicators = decision.mlIndicator ? [...ruleIndicators, decision.mlIndicator] : ruleIndicators;
    const explanation = buildExplanation(decision.riskLevel, indicators, request.type, decision.unknownReason);
    const analysisMethod: AnalysisMethod = ml.status === "used" ? "rules+ml" : "rules";

    const result: AnalysisResult = {
      analysisId: randomUUID(),
      status: "completed",
      inputType: inputTypeOverride ?? request.type,
      riskLevel: decision.riskLevel,
      risk: decision.riskLevel,
      summary: explanation,
      explanation,
      warnings: indicators.map((i) => `${i.description} (“${i.evidence}”)`),
      indicators,
      ruleIndicators,
      recommendations: buildRecommendations(decision.riskLevel, indicators, request.type),
      analysisMethod,
      modelVersion: ml.status === "used" ? ml.modelVersion : null,
      mlPrediction: {
        status: ml.status,
        reason: ml.reason,
        modelVersion: ml.modelVersion,
        probability: ml.probability,
        band: ml.band,
        label: ml.label,
        decisionThreshold: 0.5,
        truncated: ml.truncated,
        latencyMs: ml.latencyMs,
        interpretation: interpretation(ml),
      },
      modelExplanation: ml.status === "used" && ml.explanation
        ? { method: "linear_term_contributions", towardSuspicious: ml.explanation.towardSuspicious, towardLegitimate: ml.explanation.towardLegitimate, note: EXPLANATION_NOTE }
        : null,
      hybrid: {
        ruleRiskLevel: decision.ruleRiskLevel,
        adjustment: decision.adjustment,
        agreement: decision.agreement,
        reasons: decision.reasons,
        mlOnlyCanRaise: DEFAULT_HYBRID_POLICY.mlOnlyCanRaise,
      },
      ai: DEPRECATED_AI,
      language: detection.language,
      disclaimer: DISCLAIMER,
      saved: false,
      scanId: null,
      createdAt: new Date().toISOString(),
    };
    if (detection.email) {
      result.email = { senderVerified: false, fromAddress: detection.email.fromAddress, note: EMAIL_NOTE };
    }

    this.deps
      .recordStats?.({ inputType: result.inputType, riskLevel: result.riskLevel, analysisMethod })
      .catch(() => undefined);
    return result;
  }
}
