import { describe, expect, it } from "vitest";
import type { Indicator, RiskLevel } from "../../server/detection/types.ts";
import type { MlOutcome } from "../../server/ml/ml-service.ts";
import { combineSignals, DEFAULT_HYBRID_POLICY, ML_INDICATOR_CODE, type HybridInput } from "../../server/risk/hybrid.ts";
import type { RiskAssessment } from "../../server/risk/risk-engine.ts";

// The hybrid decision is tested in isolation from the classifier: ML outcomes are constructed directly.

const ind = (category: Indicator["category"] = "pressure", severity: Indicator["severity"] = "medium"): Indicator => ({
  code: `TEST_${category}`, category, severity, description: "test", evidence: "test", source: "rules",
});
const rule = (riskLevel: RiskLevel): RiskAssessment => ({ riskLevel, score: 0, categories: [], reason: "" });
const used = (probability: number, band: MlOutcome["band"]): MlOutcome => ({
  status: "used", reason: null, modelVersion: "m", probability, band, label: probability >= 0.5 ? "suspicious" : "legitimate", truncated: false, latencyMs: 1,
  explanation: { towardSuspicious: [{ term: "verify", display: "verify", weight: 1.2 }], towardLegitimate: [] },
});
const notUsed = (status: MlOutcome["status"], reason: MlOutcome["reason"]): MlOutcome => ({
  status, reason, modelVersion: null, probability: null, band: null, label: null, truncated: false, latencyMs: null, explanation: null,
});
const input = (r: RiskLevel, indicators: Indicator[], ml: MlOutcome, extra: Partial<HybridInput> = {}): HybridInput => ({
  inputType: "text", ruleIndicators: indicators, rule: rule(r), ml, insufficientContent: false, unanalyzable: false, ...extra,
});

describe("combineSignals: level table", () => {
  it.each([
    // rule level, has rule indicators, band, expected
    ["low", false, "strong", "medium"],
    ["low", true, "strong", "medium"],
    ["low", false, "elevated", "low"],
    ["low", true, "elevated", "medium"],
    ["low", false, "uncertain", "low"],
    ["low", true, "low", "low"],
    ["medium", true, "strong", "high"],
    ["medium", true, "elevated", "medium"],
    ["medium", true, "uncertain", "medium"],
    ["medium", true, "low", "medium"],
    ["high", true, "low", "high"],
    ["high", true, "strong", "high"],
  ] as const)("rules %s (indicators: %s) + ML %s -> %s", (r, hasInd, band, expected) => {
    const p = { strong: 0.97, elevated: 0.7, uncertain: 0.4, low: 0.05 }[band];
    expect(combineSignals(input(r, hasInd ? [ind()] : [], used(p, band))).riskLevel).toBe(expected);
  });

  it("never produces HIGH from the model alone", () => {
    for (const band of ["strong", "elevated", "uncertain", "low"] as const) {
      expect(combineSignals(input("low", [], used(0.999, band))).riskLevel).not.toBe("high");
    }
  });

  it("never lowers the rule level and reports disagreement", () => {
    const d = combineSignals(input("high", [ind("credentials", "high"), ind("pressure")], used(0.01, "low")));
    expect(d.riskLevel).toBe("high");
    expect(d.agreement).toBe("ml_less_suspicious");
    expect(d.reasons.join(" ")).toMatch(/not proof of safety/);
  });

  it("raises by at most one step", () => {
    expect(combineSignals(input("low", [ind("pressure", "low")], used(0.99, "strong"))).riskLevel).toBe("medium");
  });

  it("can be configured so the model alone cannot raise LOW", () => {
    expect(combineSignals(input("low", [], used(0.99, "strong")), { mlOnlyCanRaise: false }).riskLevel).toBe("low");
    expect(DEFAULT_HYBRID_POLICY.mlOnlyCanRaise).toBe(true);
  });
});

describe("combineSignals: UNKNOWN and fallbacks", () => {
  it("is UNKNOWN for unanalysable input", () => {
    expect(combineSignals(input("unknown", [], notUsed("not_applicable", "input_type_url"), { unanalyzable: true, inputType: "url" }))).toMatchObject({ riskLevel: "unknown", unknownReason: "unanalyzable" });
  });

  it("is UNKNOWN for insufficient content", () => {
    expect(combineSignals(input("unknown", [], notUsed("not_applicable", "insufficient_content"), { insufficientContent: true }))).toMatchObject({ riskLevel: "unknown", unknownReason: "insufficient_content" });
  });

  it.each(["timeout", "engine_error", "model_unavailable", "disabled", "queue_full", "invalid_output"] as const)(
    "is UNKNOWN (not LOW) when the model failed (%s) and the rules found nothing",
    (reason) => {
      expect(combineSignals(input("low", [], notUsed("failed", reason)))).toMatchObject({ riskLevel: "unknown", unknownReason: "ml_unavailable", adjustment: "unknown_without_ml" });
    },
  );

  it("is UNKNOWN for unsupported languages when the rules found nothing", () => {
    expect(combineSignals(input("low", [], notUsed("not_applicable", "unsupported_language")))).toMatchObject({ riskLevel: "unknown", unknownReason: "unsupported_language" });
  });

  it("keeps the rule result when the model failed but the rules found something", () => {
    expect(combineSignals(input("medium", [ind()], notUsed("failed", "timeout"))).riskLevel).toBe("medium");
    expect(combineSignals(input("low", [ind("pressure", "low")], notUsed("failed", "timeout"))).riskLevel).toBe("low");
  });

  it("keeps the URL engine's result for links (the model does not apply)", () => {
    expect(combineSignals(input("low", [], notUsed("not_applicable", "input_type_url"), { inputType: "url" })).riskLevel).toBe("low");
  });
});

describe("ML indicator", () => {
  it("is added for strong and elevated scores only, sourced as ml, never with HIGH severity", () => {
    const strong = combineSignals(input("low", [], used(0.97, "strong"))).mlIndicator;
    expect(strong).toMatchObject({ code: ML_INDICATOR_CODE, source: "ml", category: "statistical", severity: "medium" });
    expect(strong!.description).toMatch(/not proof/);
    expect(combineSignals(input("low", [], used(0.7, "elevated"))).mlIndicator?.severity).toBe("low");
    expect(combineSignals(input("low", [], used(0.4, "uncertain"))).mlIndicator).toBeNull();
    expect(combineSignals(input("low", [], notUsed("failed", "timeout"))).mlIndicator).toBeNull();
  });
});
