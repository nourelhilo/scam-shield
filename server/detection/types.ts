export type InputType = "text" | "url" | "email";
export type Severity = "low" | "medium" | "high";
export type RiskLevel = "low" | "medium" | "high" | "unknown";
export type Language = "en" | "ar" | "mixed" | "unknown";
export type IndicatorSource = "rules" | "url" | "email" | "ai";

/** Thematic groups. The risk engine rewards evidence spread across several categories. */
export type IndicatorCategory =
  | "pressure"
  | "credentials"
  | "financial"
  | "payment"
  | "impersonation"
  | "delivery"
  | "account"
  | "prize"
  | "investment"
  | "job"
  | "phishing"
  | "url_deception"
  | "url_structure"
  | "url_lure"
  | "sender"
  | "obfuscation"
  | "contextual";

export interface Indicator {
  code: string;
  category: IndicatorCategory;
  severity: Severity;
  description: string;
  /** Short excerpt from the submission that triggered the indicator. Never persisted. */
  evidence: string;
  source: IndicatorSource;
}

/** Public metadata describing a detection rule (used for docs, tests, and admin views). */
export interface RuleDefinition {
  id: string;
  category: IndicatorCategory;
  severity: Severity;
  description: string;
}
