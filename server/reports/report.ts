import type { ScanRow } from "../repositories/index.ts";
import { DISCLAIMER } from "../analysis/analysis-service.ts";

const RISK_LABEL = { low: "Low risk", medium: "Medium risk", high: "High risk", unknown: "Unknown risk" } as const;
const METHOD_LABEL: Record<string, string> = {
  rules: " (rule-based checks only)",
  "rules+ml": " (rule-based checks plus ScamShield's own machine-learning model)",
  // Scans saved before the external AI integration was removed.
  "rules+ai": " (rules plus external AI, legacy)",
};

/** Plain-text scan report for download. Contains no submitted content (none is stored). */
export function renderTextReport(scan: ScanRow) {
  const lines = [
    "ScamShield scan report",
    "======================",
    "",
    `Scan ID:         ${scan.id}`,
    `Date (UTC):      ${new Date(scan.created_at).toISOString()}`,
    `Input type:      ${scan.input_type}`,
    `Risk level:      ${RISK_LABEL[scan.risk_level]}`,
    `Analysis method: ${scan.analysis_method}${METHOD_LABEL[scan.analysis_method] ?? ""}`,
    ...(scan.model_version ? [`Model version:   ${scan.model_version}`] : []),
    "",
    "Explanation",
    "-----------",
    scan.explanation,
    "",
    "Warning signs",
    "-------------",
    ...(scan.indicators.length ? scan.indicators.map((i) => `- [${i.severity}] ${i.description} (${i.code})`) : ["- None found"]),
    "",
    "What to do next",
    "---------------",
    ...scan.recommendations.map((r) => `- ${r}`),
    "",
    DISCLAIMER,
    "The original submitted content is not stored by ScamShield and is not included in this report.",
    "",
  ];
  return lines.join("\n");
}

export function toScanDto(scan: ScanRow) {
  return {
    scanId: scan.id,
    inputType: scan.input_type,
    contentLength: scan.content_length,
    language: scan.language,
    riskLevel: scan.risk_level,
    indicators: scan.indicators,
    explanation: scan.explanation,
    recommendations: scan.recommendations,
    analysisMethod: scan.analysis_method,
    aiStatus: scan.ai_status,
    mlStatus: scan.ml_status,
    modelVersion: scan.model_version,
    createdAt: new Date(scan.created_at).toISOString(),
  };
}
