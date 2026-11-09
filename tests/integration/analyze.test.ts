import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StaticAiProvider } from "../../server/ai/ai-service.ts";
import { bearer, createTestApp, signUp, type TestApp } from "../helpers/app.ts";

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

describe("POST /api/analyze (rules only)", () => {
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
    const res = await analyze({ type, content });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(frontendAccepts(body)).toBe(true);
    expect(body.riskLevel).toBe(expected);
    expect(body.risk).toBe(body.riskLevel);
    expect(body.summary).toBe(body.explanation);
    expect(body.status).toBe("completed");
    expect(body.analysisMethod).toBe("rules");
    expect(body.ai.status).toBe("not_configured");
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

describe("POST /api/analyze with AI (mocked provider)", () => {
  it("combines AI indicators and labels the method truthfully", async () => {
    const t = await createTestApp({
      aiProvider: new StaticAiProvider(async () => ({
        indicators: [{ category: "contextual", severity: "medium", description: "Unusual story about a stuck refund.", evidence: "stuck refund" }],
        summary: "Mentions a stuck refund that needs action.",
      })),
    });
    try {
      const body = (await t.app.inject({ method: "POST", url: "/api/analyze", payload: { type: "text", content: "Hello, your stuck refund needs one more step today." } })).json();
      expect(body.analysisMethod).toBe("rules+ai");
      expect(body.ai.status).toBe("used");
      expect(body.ai.summary).toMatch(/stuck refund/);
      expect(body.indicators.some((i: { source: string }) => i.source === "ai")).toBe(true);
    } finally {
      await t.close();
    }
  });

  it("falls back to rules with a truthful status when the provider fails", async () => {
    const t = await createTestApp({ aiProvider: new StaticAiProvider(async () => { throw new Error("provider down"); }) });
    try {
      const res = await t.app.inject({ method: "POST", url: "/api/analyze", payload: { type: "text", content: "Your account has been suspended. Verify immediately." } });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.analysisMethod).toBe("rules");
      expect(body.ai.status).toBe("failed");
      expect(body.riskLevel).toBe("medium");
    } finally {
      await t.close();
    }
  });
});
