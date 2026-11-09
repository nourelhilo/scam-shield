import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bearer, createTestApp, signUp, type TestApp } from "../helpers/app.ts";

describe("admin and educational content", () => {
  let t: TestApp;
  let admin: string;
  let user: string;

  beforeAll(async () => {
    t = await createTestApp({ seed: true });
    admin = await signUp(t, "admin@example.com");
    user = await signUp(t, "user@example.com");
    await t.app.ctx.repos.users.setRole("admin@example.com", "admin");
  });
  afterAll(() => t.close());

  const adminRoutes: [string, string][] = [
    ["GET", "/api/admin/metrics"],
    ["GET", "/api/admin/health"],
    ["GET", "/api/admin/rules"],
    ["GET", "/api/admin/feedback"],
    ["GET", "/api/admin/articles"],
    ["GET", "/api/admin/audit-logs"],
    ["POST", "/api/admin/articles"],
    ["PATCH", "/api/admin/feedback/00000000-0000-4000-8000-000000000000"],
    ["DELETE", "/api/admin/articles/00000000-0000-4000-8000-000000000000"],
  ];

  it.each(adminRoutes)("%s %s rejects guests (401) and regular users (403)", async (method, url) => {
    expect((await t.app.inject({ method: method as "GET", url, payload: {} })).statusCode).toBe(401);
    expect((await t.app.inject({ method: method as "GET", url, payload: {}, headers: bearer(user) })).statusCode).toBe(403);
  });

  it("serves aggregate metrics without content", async () => {
    await t.app.inject({ method: "POST", url: "/api/analyze", payload: { type: "text", content: "SECRET-CONTENT-MARKER your account has been suspended, verify now" } });
    const res = await t.app.inject({ method: "GET", url: "/api/admin/metrics", headers: bearer(admin) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totals.analyses).toBeGreaterThan(0);
    expect(body.users).toBe(2);
    expect(JSON.stringify(body)).not.toContain("SECRET-CONTENT-MARKER");
  });

  it("reports operational health", async () => {
    const body = (await t.app.inject({ method: "GET", url: "/api/admin/health", headers: bearer(admin) })).json();
    expect(body.database).toEqual({ kind: "pglite", reachable: true });
    expect(body.ai.configured).toBe(false);
    expect(body.rateLimiting.store).toMatch(/in-memory/);
  });

  it("reviews feedback and writes an audit log entry", async () => {
    const analysis = (await t.app.inject({ method: "POST", url: "/api/analyze", payload: { type: "text", content: "Lunch at noon tomorrow at the usual place?" } })).json();
    await t.app.inject({ method: "POST", url: "/api/feedback", payload: { feedbackType: "missed_scam", analysisId: analysis.analysisId } });
    const list = (await t.app.inject({ method: "GET", url: "/api/admin/feedback?status=open", headers: bearer(admin) })).json();
    expect(list.total).toBe(1);
    const id = list.items[0].id;
    const res = await t.app.inject({ method: "PATCH", url: `/api/admin/feedback/${id}`, payload: { status: "reviewed" }, headers: bearer(admin) });
    expect(res.json().status).toBe("reviewed");
    const logs = (await t.app.inject({ method: "GET", url: "/api/admin/audit-logs", headers: bearer(admin) })).json();
    expect(logs.items[0]).toMatchObject({ action: "feedback.status_changed", target_id: id, actor_email: "admin@example.com" });
  });

  it("lists seeded published articles publicly with category filters", async () => {
    const all = (await t.app.inject({ method: "GET", url: "/api/articles" })).json();
    expect(all.total).toBe(7);
    expect(all.items[0].body).toBeUndefined(); // list omits bodies
    const sms = (await t.app.inject({ method: "GET", url: "/api/articles?category=sms_scams" })).json();
    expect(sms.items.every((a: { category: string }) => a.category === "sms_scams")).toBe(true);
    const arabic = (await t.app.inject({ method: "GET", url: "/api/articles?language=ar" })).json();
    expect(arabic.total).toBe(1);
    const one = (await t.app.inject({ method: "GET", url: "/api/articles/spotting-phishing-messages" })).json();
    expect(one.article.body).toMatch(/Phishing/);
    expect((await t.app.inject({ method: "GET", url: "/api/articles?category=cooking" })).statusCode).toBe(400);
  });

  it("creates, updates, publishes, unpublishes, and deletes an article (audited)", async () => {
    const draft = {
      slug: "gift-card-scams",
      title: "Gift card scams",
      category: "payment_safety",
      language: "en",
      summary: "Nobody legitimate asks for payment in gift cards.",
      body: "If someone asks you to pay with gift cards, it is a scam warning sign.",
    };
    const created = await t.app.inject({ method: "POST", url: "/api/admin/articles", payload: draft, headers: bearer(admin) });
    expect(created.statusCode).toBe(201);
    const id = created.json().article.id;
    expect(created.json().article.status).toBe("draft");

    // Drafts are invisible publicly
    expect((await t.app.inject({ method: "GET", url: "/api/articles/gift-card-scams" })).statusCode).toBe(404);
    expect((await t.app.inject({ method: "POST", url: "/api/admin/articles", payload: draft, headers: bearer(admin) })).statusCode).toBe(409);

    const updated = await t.app.inject({ method: "PATCH", url: `/api/admin/articles/${id}`, payload: { title: "Gift card payment scams" }, headers: bearer(admin) });
    expect(updated.json().article.title).toBe("Gift card payment scams");

    const pub = await t.app.inject({ method: "POST", url: `/api/admin/articles/${id}/publish`, headers: bearer(admin) });
    expect(pub.json().article.status).toBe("published");
    expect(pub.json().article.publishedAt).not.toBeNull();
    expect((await t.app.inject({ method: "GET", url: "/api/articles/gift-card-scams" })).statusCode).toBe(200);

    await t.app.inject({ method: "POST", url: `/api/admin/articles/${id}/unpublish`, headers: bearer(admin) });
    expect((await t.app.inject({ method: "GET", url: "/api/articles/gift-card-scams" })).statusCode).toBe(404);

    expect((await t.app.inject({ method: "DELETE", url: `/api/admin/articles/${id}`, headers: bearer(admin) })).statusCode).toBe(204);
    const actions = (await t.app.inject({ method: "GET", url: "/api/admin/audit-logs?limit=10", headers: bearer(admin) })).json().items.map((l: { action: string }) => l.action);
    expect(actions).toEqual(expect.arrayContaining(["article.created", "article.updated", "article.published", "article.unpublished", "article.deleted"]));
  });

  it("validates article input", async () => {
    const bad = await t.app.inject({ method: "POST", url: "/api/admin/articles", payload: { slug: "Bad Slug!", title: "x", category: "phishing", language: "en", summary: "short", body: "short" }, headers: bearer(admin) });
    expect(bad.statusCode).toBe(400);
  });

  it("exposes the rule catalogue to admins", async () => {
    const body = (await t.app.inject({ method: "GET", url: "/api/admin/rules", headers: bearer(admin) })).json();
    expect(body.text.length).toBeGreaterThan(15);
    expect(body.url.length).toBeGreaterThan(15);
    expect(body.email.length).toBe(6);
  });
});
