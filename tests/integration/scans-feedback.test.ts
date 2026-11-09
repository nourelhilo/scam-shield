import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bearer, createTestApp, signUp, type TestApp } from "../helpers/app.ts";

describe("scan history", () => {
  let t: TestApp;
  let alice: string;
  let bob: string;
  const save = (token: string, content: string) =>
    t.app.inject({ method: "POST", url: "/api/analyze", payload: { type: "text", content, save: true }, headers: bearer(token) }).then((r) => r.json().scanId as string);

  beforeAll(async () => {
    t = await createTestApp();
    alice = await signUp(t, "alice@example.com");
    bob = await signUp(t, "bob@example.com");
  });
  afterAll(() => t.close());

  it("lists only the caller's scans, newest first, with filters", async () => {
    const high = await save(alice, "Your account has been suspended. Reply with your password and the verification code.");
    const low = await save(alice, "See you at the station at six, bring the tickets please.");
    await save(bob, "Bob's own message about lunch at the usual place today.");

    const all = (await t.app.inject({ method: "GET", url: "/api/scans", headers: bearer(alice) })).json();
    expect(all.total).toBe(2);
    expect(all.items.map((s: { scanId: string }) => s.scanId)).toEqual([low, high]);

    const onlyHigh = (await t.app.inject({ method: "GET", url: "/api/scans?riskLevel=high", headers: bearer(alice) })).json();
    expect(onlyHigh.items.map((s: { scanId: string }) => s.scanId)).toEqual([high]);

    const future = (await t.app.inject({ method: "GET", url: "/api/scans?from=2999-01-01", headers: bearer(alice) })).json();
    expect(future.total).toBe(0);
    const today = new Date().toISOString().slice(0, 10);
    const todayList = (await t.app.inject({ method: "GET", url: `/api/scans?from=${today}&to=${today}`, headers: bearer(alice) })).json();
    expect(todayList.total).toBe(2);
  });

  it("returns a single scan and a downloadable report", async () => {
    const id = await save(alice, "Congratulations! You have won a prize. Pay the processing fee by gift card.");
    const one = await t.app.inject({ method: "GET", url: `/api/scans/${id}`, headers: bearer(alice) });
    expect(one.statusCode).toBe(200);
    expect(one.json().scan.scanId).toBe(id);

    const txt = await t.app.inject({ method: "GET", url: `/api/scans/${id}/report`, headers: bearer(alice) });
    expect(txt.statusCode).toBe(200);
    expect(txt.headers["content-type"]).toMatch(/text\/plain/);
    expect(txt.headers["content-disposition"]).toMatch(/attachment; filename="scamshield-report-.*\.txt"/);
    expect(txt.body).toMatch(/ScamShield scan report/);
    expect(txt.body).not.toMatch(/gift card\./); // no submitted content in the report

    const json = await t.app.inject({ method: "GET", url: `/api/scans/${id}/report?format=json`, headers: bearer(alice) });
    expect(json.json().report.scanId).toBe(id);
  });

  it("never exposes or deletes another user's scan", async () => {
    const id = await save(alice, "Your parcel is on hold, pay the customs fee now.");
    for (const [method, url] of [["GET", `/api/scans/${id}`], ["GET", `/api/scans/${id}/report`], ["DELETE", `/api/scans/${id}`]] as const) {
      const res = await t.app.inject({ method, url, headers: bearer(bob) });
      expect(res.statusCode).toBe(404);
    }
    expect((await t.app.inject({ method: "GET", url: `/api/scans/${id}`, headers: bearer(alice) })).statusCode).toBe(200);
  });

  it("deletes one scan and then all scans (only the caller's)", async () => {
    const id = await save(alice, "Click the link below to verify your account today.");
    expect((await t.app.inject({ method: "DELETE", url: `/api/scans/${id}`, headers: bearer(alice) })).statusCode).toBe(204);
    expect((await t.app.inject({ method: "GET", url: `/api/scans/${id}`, headers: bearer(alice) })).statusCode).toBe(404);

    const res = await t.app.inject({ method: "DELETE", url: "/api/scans", headers: bearer(alice) });
    expect(res.json().deleted).toBeGreaterThan(0);
    expect((await t.app.inject({ method: "GET", url: "/api/scans", headers: bearer(alice) })).json().total).toBe(0);
    expect((await t.app.inject({ method: "GET", url: "/api/scans", headers: bearer(bob) })).json().total).toBe(1);
  });

  it("requires authentication and valid parameters", async () => {
    expect((await t.app.inject({ method: "GET", url: "/api/scans" })).statusCode).toBe(401);
    expect((await t.app.inject({ method: "GET", url: "/api/scans/not-a-uuid", headers: bearer(alice) })).statusCode).toBe(400);
    expect((await t.app.inject({ method: "GET", url: "/api/scans?riskLevel=extreme", headers: bearer(alice) })).statusCode).toBe(400);
    expect((await t.app.inject({ method: "GET", url: "/api/scans?limit=1000", headers: bearer(alice) })).statusCode).toBe(400);
  });
});

describe("feedback", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it("accepts guest feedback by analysisId", async () => {
    const analysis = (await t.app.inject({ method: "POST", url: "/api/analyze", payload: { type: "text", content: "Lunch at noon tomorrow at the usual place?" } })).json();
    const res = await t.app.inject({ method: "POST", url: "/api/feedback", payload: { feedbackType: "missed_scam", analysisId: analysis.analysisId, comment: "This was actually a scam" } });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe("received");
  });

  it("accepts feedback on the caller's own saved scan only", async () => {
    const a = await signUp(t, "fa@example.com");
    const b = await signUp(t, "fb@example.com");
    const scanId = (await t.app.inject({ method: "POST", url: "/api/analyze", payload: { type: "text", content: "Verify your account at the link below now.", save: true }, headers: bearer(a) })).json().scanId;
    expect((await t.app.inject({ method: "POST", url: "/api/feedback", payload: { feedbackType: "false_positive", scanId }, headers: bearer(a) })).statusCode).toBe(201);
    expect((await t.app.inject({ method: "POST", url: "/api/feedback", payload: { feedbackType: "false_positive", scanId }, headers: bearer(b) })).statusCode).toBe(404);
    expect((await t.app.inject({ method: "POST", url: "/api/feedback", payload: { feedbackType: "false_positive", scanId } })).statusCode).toBe(401);
  });

  it("validates feedback", async () => {
    const id = "00000000-0000-4000-8000-000000000000";
    for (const payload of [{ feedbackType: "nonsense", analysisId: id }, { feedbackType: "other" }, { feedbackType: "other", analysisId: id, comment: "x".repeat(1001) }, { feedbackType: "other", analysisId: "abc" }]) {
      expect((await t.app.inject({ method: "POST", url: "/api/feedback", payload })).statusCode).toBe(400);
    }
  });

  it("does not change detection results based on feedback", async () => {
    const content = "Your account has been suspended. Verify immediately.";
    const before = (await t.app.inject({ method: "POST", url: "/api/analyze", payload: { type: "text", content } })).json();
    for (let i = 0; i < 5; i++) {
      await t.app.inject({ method: "POST", url: "/api/feedback", payload: { feedbackType: "false_positive", analysisId: before.analysisId } });
    }
    const after = (await t.app.inject({ method: "POST", url: "/api/analyze", payload: { type: "text", content } })).json();
    expect(after.riskLevel).toBe(before.riskLevel);
  });
});
