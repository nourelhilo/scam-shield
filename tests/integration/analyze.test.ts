import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bearer, createTestApp, signUp, type TestApp } from "../helpers/app.ts";
import { crashingEngine, FakeEngine, fooledPrediction, hangingEngine } from "../helpers/ml.ts";
import { DEFAULT_MODEL_VERSION } from "../../server/ml/model-path.ts";

/**
 * The exact acceptance check from the existing frontend (checker.js renderResult).
 * If this passes, the current UI can display our response without any frontend change.
 */
function frontendAccepts(report: Record<string, unknown>) {
  const riskLabels = { low: 1, medium: 1, high: 1, unknown: 1 };
  const isNonemptyString = (v: unknown) => typeof v === "string" && v.trim().length > 0;
  const risk = typeof report?.risk === "string" ? report.risk.trim().toLowerCase() : "";
  return (
    Object.hasOwn(riskLabels, risk) &&
    isNonemptyString(report.summary) &&
    Array.isArray(report.warnings) && report.warnings.every(isNonemptyString) &&
    Array.isArray(report.recommendations) && report.recommendations.every(isNonemptyString)
  );
}

describe("POST /api/analyze (rules + ScamShield ML model)", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  const analyze = (payload: unknown, headers: Record<string, string> = {}) =>
    t.app.inject({ method: "POST", url: "/api/analyze", payload: payload as object, headers });

  it.each([
    ["text", "Your delivery is on hold. Pay a redelivery fee in the next 30 minutes at https://parcel-alert.example/release.", "high"],
    ["url", "https://account-verify.example/confirm-password", "medium"],
    ["email", "Subject: Immediate action required\n\nYour account will be locked today. Reply with your password and the six-digit verification code we just sent you.", "high"],
  ])("analyses the frontend's %s example and the UI accepts the response", async (type, content, expected) => {
    // These are the three examples built into index.html/checker.js.
    const res = await analyze({ type, content });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(frontendAccepts(body)).toBe(true);
    expect(body.riskLevel).toBe(expected);
    expect(body.risk).toBe(body.riskLevel);
    expect(body.summary).toBe(body.explanation);
    expect(body.status).toBe("completed");
    // Text and email go through the real ML model; links are assessed by the URL engine only.
    expect(body.analysisMethod).toBe(type === "url" ? "rules" : "rules+ml");
    expect(body.mlPrediction.status).toBe(type === "url" ? "not_applicable" : "used");
    expect(body.ai).toEqual({ status: "not_configured", provider: null, model: null, summary: null, reason: "external_ai_removed" });
    expect(body.analysisId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.saved).toBe(false);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("returns evidence-backed indicators", async () => {
    const body = (await analyze({ type: "text", content: "Congratulations, you have won! Send Google Play cards to claim your prize." })).json();
    expect(body.indicators.length).toBeGreaterThan(0);
    for (const i of body.indicators) {
      expect(i).toEqual(expect.objectContaining({ code: expect.any(String), severity: expect.stringMatching(/^(low|medium|high)$/), description: expect.any(String), evidence: expect.any(String) }));
    }
  });

  it("returns LOW (with a caveat) for an ordinary message", async () => {
    const body = (await analyze({ type: "text", content: "Hi, are we still meeting for lunch at noon tomorrow?" })).json();
    expect(body.riskLevel).toBe("low");
    expect(body.explanation).toMatch(/does not guarantee/);
    expect(frontendAccepts(body)).toBe(true);
  });

  it("returns UNKNOWN for too little content", async () => {
    const body = (await analyze({ type: "text", content: "ok" })).json();
    expect(body.riskLevel).toBe("unknown");
    expect(frontendAccepts(body)).toBe(true);
  });

  it("marks pasted email senders as unverified", async () => {
    const body = (await analyze({ type: "email", content: "From: PayPal <a@paypa1.com>\nSubject: Limited\n\nYour account has been limited." })).json();
    expect(body.email.senderVerified).toBe(false);
    expect(body.email.note).toMatch(/SPF, DKIM, DMARC/);
  });

  it("analyses Arabic text", async () => {
    const body = (await analyze({ type: "text", content: "عزيزي العميل، تم تعليق حسابك. يرجى ارسال رمز التحقق فوراً عبر الرابط" })).json();
    expect(body.language).toBe("ar");
    expect(body.riskLevel).toBe("high");
  });

  it("rejects an unparseable URL", async () => {
    const res = await analyze({ type: "url", content: "http://" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("requires sign-in to save", async () => {
    const res = await analyze({ type: "text", content: "hello there friend", save: true });
    expect(res.statusCode).toBe(401);
  });

  it("does not store guest scans", async () => {
    await analyze({ type: "text", content: "Your account has been suspended, verify now." });
    expect(await t.app.ctx.repos.scans.count()).toBe(0);
  });

  it("records anonymous aggregate stats only", async () => {
    const rows = await t.app.ctx.repos.stats.summary(1);
    expect(rows.length).toBeGreaterThan(0);
    expect(Object.keys(rows[0]!).sort()).toEqual(["analysis_method", "count", "day", "input_type", "risk_level"]);
  });

  it("saves to history when signed in and save=true, without content or evidence", async () => {
    const token = await signUp(t, "saver@example.com");
    const content = "Your account has been suspended. Reply with your password immediately.";
    const res = await analyze({ type: "text", content, save: true }, bearer(token));
    const body = res.json();
    expect(body.saved).toBe(true);
    expect(body.scanId).toMatch(/^[0-9a-f-]{36}$/);
    const rows = await t.app.ctx.db.query("SELECT * FROM scans");
    const stored = JSON.stringify(rows.rows);
    expect(stored).not.toContain("Reply with your password");
    expect(stored).not.toContain("evidence");
    expect(rows.rows[0]).toMatchObject({ content_length: content.length });
  });
});

describe("POST /api/analyze ML integration", () => {
  const post = (t: TestApp, payload: object) => t.app.inject({ method: "POST", url: "/api/analyze", payload });

  it("runs real inference and returns the new optional fields", async () => {
    const t = await createTestApp();
    try {
      const body = (await post(t, { type: "text", content: "USPS: your parcel is on hold due to an incomplete address. Update it here https://usps-redelivery-info.com/track" })).json();
      expect(frontendAccepts(body)).toBe(true);
      expect(body.analysisMethod).toBe("rules+ml");
      expect(body.modelVersion).toBe(DEFAULT_MODEL_VERSION);
      expect(body.mlPrediction).toMatchObject({ status: "used", reason: null, modelVersion: DEFAULT_MODEL_VERSION, label: "suspicious", decisionThreshold: 0.5 });
      expect(body.mlPrediction.probability).toBeGreaterThan(0.9);
      expect(body.mlPrediction.interpretation).toMatch(/not a calibrated probability/);
      expect(body.modelExplanation.method).toBe("linear_term_contributions");
      expect(body.modelExplanation.towardSuspicious.length).toBeGreaterThan(0);
      expect(body.ruleIndicators.every((i: { source: string }) => i.source !== "ml")).toBe(true);
      expect(body.indicators.some((i: { code: string }) => i.code === "ML_SCAM_LIKE_WORDING")).toBe(true);
      expect(body.hybrid).toMatchObject({ ruleRiskLevel: expect.any(String), adjustment: expect.any(String), mlOnlyCanRaise: true });
    } finally {
      await t.close();
    }
  });

  it("does not apply the text model to bare URLs", async () => {
    const t = await createTestApp();
    try {
      const body = (await post(t, { type: "url", content: "https://example.com/" })).json();
      expect(body.mlPrediction).toMatchObject({ status: "not_applicable", reason: "input_type_url", probability: null });
      expect(body.modelExplanation).toBeNull();
      expect(body.analysisMethod).toBe("rules");
      expect(frontendAccepts(body)).toBe(true);
    } finally {
      await t.close();
    }
  });

  it("applies the model to email subject + body", async () => {
    const t = await createTestApp();
    try {
      const body = (await post(t, { type: "email", content: "", email: { from: "Security <alerts@secure-mail.top>", subject: "Account suspended", body: "Dear customer, confirm your login details at the link below within 24 hours or your account will be closed." } })).json();
      expect(body.mlPrediction.status).toBe("used");
      expect(body.email.senderVerified).toBe(false);
      expect(frontendAccepts(body)).toBe(true);
    } finally {
      await t.close();
    }
  });

  it("does not apply the English-only model to Arabic text, and says so", async () => {
    const t = await createTestApp();
    try {
      const scam = (await post(t, { type: "text", content: "عزيزي العميل، تم تعليق حسابك. يرجى ارسال رمز التحقق فوراً عبر الرابط" })).json();
      expect(scam.mlPrediction).toMatchObject({ status: "not_applicable", reason: "unsupported_language" });
      expect(scam.riskLevel).toBe("high"); // the Arabic rules still work
      const benign = (await post(t, { type: "text", content: "مرحبا، هل نلتقي غدا بعد العمل لتناول القهوة؟" })).json();
      // No rule findings and no model support: not enough evidence to call it LOW.
      expect(benign.riskLevel).toBe("unknown");
      expect(benign.explanation).toMatch(/does not support this language/);
      expect(frontendAccepts(benign)).toBe(true);
    } finally {
      await t.close();
    }
  });

  it("falls back to rules with a truthful status when the ML engine fails", async () => {
    const t = await createTestApp({ mlEngine: crashingEngine() });
    try {
      const res = await post(t, { type: "text", content: "Your account has been suspended. Verify immediately." });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.analysisMethod).toBe("rules");
      expect(body.mlPrediction).toMatchObject({ status: "failed", reason: "engine_error", probability: null });
      expect(body.modelExplanation).toBeNull();
      expect(body.riskLevel).toBe("medium");
      expect(frontendAccepts(body)).toBe(true);
    } finally {
      await t.close();
    }
  });

  it("returns UNKNOWN (not LOW) when the model times out and the rules find nothing", async () => {
    const t = await createTestApp({ mlEngine: hangingEngine(), mlTimeoutMs: 300 });
    try {
      const started = Date.now();
      const body = (await post(t, { type: "text", content: "Hi, are we still meeting for lunch at noon tomorrow?" })).json();
      expect(Date.now() - started).toBeLessThan(2000);
      expect(body.mlPrediction).toMatchObject({ status: "failed", reason: "timeout" });
      expect(body.riskLevel).toBe("unknown");
      expect(body.explanation).toMatch(/machine-learning check could not run/);
      expect(frontendAccepts(body)).toBe(true);
    } finally {
      await t.close();
    }
  });

  it("never lets a low model score lower a rule-based HIGH (fooled-model double)", async () => {
    const t = await createTestApp({ mlEngine: new FakeEngine(async () => fooledPrediction()) });
    try {
      const body = (await post(t, { type: "text", content: "Your account has been suspended. Reply with your password and the verification code immediately." })).json();
      expect(body.riskLevel).toBe("high");
      expect(body.hybrid.agreement).toBe("ml_less_suspicious");
    } finally {
      await t.close();
    }
  });

  it("rejects malformed model output instead of using it", async () => {
    const t = await createTestApp({ mlEngine: new FakeEngine(async () => ({ ...fooledPrediction(), probability: 7 })) });
    try {
      const body = (await post(t, { type: "text", content: "Your account has been suspended. Verify immediately." })).json();
      expect(body.mlPrediction).toMatchObject({ status: "failed", reason: "invalid_output", probability: null });
      expect(body.analysisMethod).toBe("rules");
    } finally {
      await t.close();
    }
  });

  it("with ML disabled, runs rules only and reports it", async () => {
    const t = await createTestApp({ mlEngine: null });
    try {
      const body = (await post(t, { type: "text", content: "Your account has been suspended. Verify immediately." })).json();
      expect(body.mlPrediction).toMatchObject({ status: "unavailable", reason: "disabled" });
      expect(body.riskLevel).toBe("medium");
      const health = (await t.app.inject({ method: "GET", url: "/api/health" })).json();
      expect(health.capabilities).toMatchObject({ ml: false, ai: false });
    } finally {
      await t.close();
    }
  });
});
