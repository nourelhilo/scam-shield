import type { Indicator, IndicatorCategory, InputType, RiskLevel, Severity } from "../detection/types.ts";

/**
 * Risk classification - deterministic, explainable, and independently testable.
 *
 * Scoring:
 *   severity weights:  low = 1, medium = 2, high = 3
 *   Within one category only the strongest indicator counts fully; each additional
 *   indicator in the same category adds 1 (so repeating one theme cannot inflate risk).
 *
 * Thresholds:
 *   HIGH    score >= 6 AND evidence in at least 2 different categories,
 *           OR at least 2 high-severity indicators in different categories.
 *   MEDIUM  score >= 3, OR any single high-severity indicator.
 *   LOW     anything below MEDIUM - including no indicators at all, when there was
 *           enough content to assess. LOW never means "safe".
 *   UNKNOWN not enough content to assess (and nothing suspicious found),
 *           or the input could not be analysed (e.g. unparseable).
 *
 * The engine never outputs a confidence percentage: the classification is a rule-based
 * judgement over the listed indicators, not a calibrated probability.
 */
export const SEVERITY_WEIGHT: Record<Severity, number> = { low: 1, medium: 2, high: 3 };

export const THRESHOLDS = {
  highScore: 6,
  highMinCategories: 2,
  mediumScore: 3,
} as const;

export interface RiskAssessment {
  riskLevel: RiskLevel;
  score: number;
  categories: IndicatorCategory[];
  reason: string;
}

export interface AssessOptions {
  inputType: InputType;
  /** True when the content was too short or empty to judge. */
  insufficientContent: boolean;
  /** True when the input could not be parsed at all (e.g. an invalid URL). */
  unanalyzable?: boolean;
}

export function scoreIndicators(indicators: Indicator[]) {
  const byCategory = new Map<IndicatorCategory, number[]>();
  for (const ind of indicators) {
    const list = byCategory.get(ind.category) ?? [];
    list.push(SEVERITY_WEIGHT[ind.severity]);
    byCategory.set(ind.category, list);
  }
  let score = 0;
  for (const weights of byCategory.values()) {
    weights.sort((a, b) => b - a);
    score += weights[0]! + (weights.length - 1);
  }
  return { score, categories: [...byCategory.keys()].sort() };
}

export function assessRisk(indicators: Indicator[], options: AssessOptions): RiskAssessment {
  const { score, categories } = scoreIndicators(indicators);

  if (options.unanalyzable) {
    return { riskLevel: "unknown", score, categories, reason: "The input could not be analysed." };
  }
  if (indicators.length === 0) {
    return options.insufficientContent
      ? { riskLevel: "unknown", score: 0, categories, reason: "Not enough content to assess." }
      : { riskLevel: "low", score: 0, categories, reason: "No known scam indicators were found." };
  }

  const highCategories = new Set(indicators.filter((i) => i.severity === "high").map((i) => i.category));

  if ((score >= THRESHOLDS.highScore && categories.length >= THRESHOLDS.highMinCategories) || highCategories.size >= 2) {
    return { riskLevel: "high", score, categories, reason: "Multiple independent scam indicators were found." };
  }
  if (score >= THRESHOLDS.mediumScore || highCategories.size >= 1) {
    return { riskLevel: "medium", score, categories, reason: "Some scam indicators were found." };
  }
  return { riskLevel: "low", score, categories, reason: "Only weak indicators were found." };
}
