import { describe, expect, it } from "vitest";
import type { Indicator, IndicatorCategory, Severity } from "../../server/detection/types.ts";
import { buildExplanation, buildRecommendations } from "../../server/risk/explain.ts";
import { assessRisk, scoreIndicators } from "../../server/risk/risk-engine.ts";

const ind = (category: IndicatorCategory, severity: Severity, code = `${category}_${severity}`): Indicator => ({
  code,
  category,
  severity,
  description: "d",
  evidence: "e",
  source: "rules",
});
const opts = { inputType: "text" as const, insufficientContent: false };

describe("risk engine", () => {
  it("returns LOW (not safe) when there is enough content and no indicators", () => {
    expect(assessRisk([], opts).riskLevel).toBe("low");
  });
  it("returns UNKNOWN when content is insufficient and nothing was found", () => {
    expect(assessRisk([], { ...opts, insufficientContent: true }).riskLevel).toBe("unknown");
  });
  it("returns UNKNOWN for unanalysable input", () => {
    expect(assessRisk([ind("url_deception", "high")], { ...opts, unanalyzable: true }).riskLevel).toBe("unknown");
  });
  it("does not let a single medium keyword decide fraud", () => {
    expect(assessRisk([ind("pressure", "medium")], opts).riskLevel).toBe("low");
  });
  it("treats one high-severity indicator as MEDIUM, not HIGH", () => {
    expect(assessRisk([ind("credentials", "high")], opts).riskLevel).toBe("medium");
  });
  it("returns MEDIUM at score 3", () => {
    expect(assessRisk([ind("pressure", "medium"), ind("prize", "low")], opts).riskLevel).toBe("medium");
  });
  it("returns HIGH for two high indicators in different categories", () => {
    expect(assessRisk([ind("credentials", "high"), ind("payment", "high")], opts).riskLevel).toBe("high");
  });
  it("returns HIGH for score >= 6 across 2+ categories", () => {
    expect(assessRisk([ind("pressure", "medium"), ind("delivery", "medium"), ind("payment", "medium")], opts).riskLevel).toBe("high");
  });
  it("dampens repeated indicators in one category", () => {
    const many = [ind("pressure", "medium", "A"), ind("pressure", "medium", "B"), ind("pressure", "medium", "C"), ind("pressure", "medium", "D")];
    expect(scoreIndicators(many).score).toBe(5); // 2 + 1 + 1 + 1
    expect(assessRisk(many, opts).riskLevel).toBe("medium"); // one theme can never reach HIGH
  });
  it("is deterministic", () => {
    const list = [ind("credentials", "high"), ind("pressure", "medium")];
    expect(assessRisk(list, opts)).toEqual(assessRisk([...list].reverse(), opts));
  });
  it("never produces a confidence percentage", () => {
    expect(JSON.stringify(assessRisk([ind("credentials", "high")], opts))).not.toMatch(/confidence|%/);
  });
});

describe("explanations and recommendations", () => {
  it("never calls something safe or definitively fraudulent", () => {
    for (const level of ["low", "medium", "high", "unknown"] as const) {
      const text = buildExplanation(level, level === "low" ? [] : [ind("credentials", "high")], "text");
      // Only negated forms such as "does not guarantee it is safe" may mention safety.
      expect(text).not.toMatch(/\bthis (message|link|email) is (safe|a scam|fraudulent)\b|\bdefinitely\b|\bis guaranteed\b/i);
    }
    expect(buildExplanation("low", [], "url")).toMatch(/does not guarantee/);
  });
  it("tailors recommendations to indicators and is never empty", () => {
    expect(buildRecommendations("high", [ind("credentials", "high")], "text").join(" ")).toMatch(/one-time codes/);
    expect(buildRecommendations("high", [ind("payment", "high")], "text").join(" ")).toMatch(/gift cards/);
    for (const level of ["low", "medium", "high", "unknown"] as const) {
      expect(buildRecommendations(level, [], "text").length).toBeGreaterThan(0);
    }
  });
});
