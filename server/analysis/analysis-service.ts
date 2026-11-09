import { randomUUID } from "node:crypto";
import type { AiService, AiStatus } from "../ai/ai-service.ts";
import { runDetection } from "../detection/detect.ts";
import type { Indicator, InputType, Language, RiskLevel } from "../detection/types.ts";
import { buildExplanation, buildRecommendations } from "../risk/explain.ts";
import { assessRisk } from "../risk/risk-engine.ts";
import type { AnalyzeRequest } from "./schemas.ts";

export type AnalysisMethod = "rules" | "rules+ai";

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
  indicators: Indicator[];
  recommendations: string[];
  analysisMethod: AnalysisMethod;
  ai: {
    status: AiStatus;
    provider: string | null;
    model: string | null;
    /** Model-written context. Advisory only; never changes the risk level downward. */
    summary: string | null;
    reason: string | null;
  };
  language: Language;
  email?: { senderVerified: false; fromAddress: string | null; note: string };
  disclaimer: string;
  saved: boolean;
  scanId: string | null;
  createdAt: string;
}

export const DISCLAIMER =
  "ScamShield gives an automated risk estimate based on known warning signs. It cannot guarantee that something is safe or prove that it is fraudulent. Verify unexpected requests through an official channel.";

const EMAIL_NOTE =
  "Sender details were pasted by you and cannot be verified. Email authentication (SPF, DKIM, DMARC) was not checked.";

export interface AnalysisDependencies {
  ai: AiService;
  /** Called with anonymous counts only (no content, no user id). Failures are ignored. */
  recordStats?: (stat: { inputType: string; riskLevel: RiskLevel; analysisMethod: AnalysisMethod }) => Promise<void>;
}

export class AnalysisService {
  constructor(private readonly deps: AnalysisDependencies) {}

  get aiConfigured() {
    return this.deps.ai.configured;
  }

  async analyze(request: Pick<AnalyzeRequest, "type" | "content" | "email">, inputTypeOverride?: "image"): Promise<AnalysisResult> {
    const detection = runDetection({ type: request.type, content: request.content, email: request.email });

    let ai = await (detection.unanalyzable || detection.insufficientContent
      ? Promise.resolve(null)
      : this.deps.ai.analyze({
          type: request.type,
          content: request.type === "email" ? detection.analysedText : request.content,
          ruleIndicatorCodes: detection.indicators.map((i) => i.code),
        }));

    const aiStatus: AiStatus = ai ? ai.status : this.deps.ai.configured ? "skipped" : "not_configured";
    const aiReason = ai ? ai.failureReason : this.deps.ai.configured ? "insufficient_content" : null;
    if (ai && ai.status !== "used") ai = { ...ai, indicators: [], summary: null };

    // AI indicators can only add evidence; they never remove rule findings.
    const indicators = [...detection.indicators, ...(ai?.indicators ?? [])];
    const assessment = assessRisk(indicators, {
      inputType: request.type,
      insufficientContent: detection.insufficientContent,
      unanalyzable: detection.unanalyzable,
    });

    const explanation = buildExplanation(assessment.riskLevel, indicators, request.type);
    const analysisMethod: AnalysisMethod = aiStatus === "used" ? "rules+ai" : "rules";

    const result: AnalysisResult = {
      analysisId: randomUUID(),
      status: "completed",
      inputType: inputTypeOverride ?? request.type,
      riskLevel: assessment.riskLevel,
      risk: assessment.riskLevel,
      summary: explanation,
      explanation,
      warnings: indicators.map((i) => `${i.description} (“${i.evidence}”)`),
      indicators,
      recommendations: buildRecommendations(assessment.riskLevel, indicators, request.type),
      analysisMethod,
      ai: {
        status: aiStatus,
        provider: ai?.provider ?? null,
        model: ai?.model ?? null,
        summary: aiStatus === "used" ? (ai?.summary ?? null) : null,
        reason: aiReason,
      },
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
