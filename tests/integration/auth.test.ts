import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bearer, createTestApp, signUp, tokenFromMail, type TestApp } from "../helpers/app.ts";

describe("authentication", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  const post = (url: string, payload: object, headers: Record<string, string> = {}) => t.app.inject({ method: "POST", url, payload, headers });

  it("registers, requires verification, then logs in", async () => {
    const email = "alice@example.com";
    const password = "a long passphrase";
    const reg = await post("/api/auth/register", { email, password, displayName: "Alice" });
    expect(reg.statusCode).toBe(202);

    const blocked = await post("/api/auth/login", { email, password });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe("EMAIL_NOT_VERIFIED");

    const token = tokenFromMail(t.mailer.lastTo(email)!.text, "ev");
    const verify = await t.app.inject({ method: "GET", url: `/api/auth/verify-email?token=${token}` });
    expect(verify.statusCode).toBe(200);
    expect(verify.body).toMatch(/verified/);

    const reuse = await post("/api/auth/verify-email", { token });
    expect(reuse.statusCode).toBe(400); // single-use

    const login = await post("/api/auth/login", { email: "ALICE@example.com", password });
    expect(login.statusCode).toBe(200);
    const session = login.json();
    expect(session.tokenType).toBe("Bearer");
    expect(session.user).toMatchObject({ email, displayName: "Alice", role: "user", emailVerified: true });
    expect(JSON.stringify(session.user)).not.toMatch(/password/i);

    const me = await t.app.inject({ method: "GET", url: "/api/me", headers: bearer(session.token) });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe(email);
  });

  it("does not reveal whether an email is registered", async () => {
    await signUp(t, "bob@example.com");
    const again = await post("/api/auth/register", { email: "bob@example.com", password: "another passphrase" });
    const fresh = await post("/api/auth/register", { email: "new-person@example.com", password: "another passphrase" });
    expect(again.statusCode).toBe(fresh.statusCode);
    expect(again.json()).toEqual(fresh.json());

    const wrongPass = await post("/api/auth/login", { email: "bob@example.com", password: "wrong password!!" });
    const noUser = await post("/api/auth/login", { email: "nobody@example.com", password: "wrong password!!" });
    expect(wrongPass.statusCode).toBe(401);
    expect(wrongPass.json()).toEqual(noUser.json());

    const r1 = await post("/api/auth/password-reset/request", { email: "bob@example.com" });
    const r2 = await post("/api/auth/password-reset/request", { email: "nobody@example.com" });
    expect(r1.json()).toEqual(r2.json());
  });

  it("stores only password hashes and token hashes", async () => {
    await signUp(t, "hash-check@example.com", "plaintext passphrase");
    const users = await t.app.ctx.db.query<{ password_hash: string }>("SELECT password_hash FROM users WHERE email = $1", ["hash-check@example.com"]);
    expect(users.rows[0]!.password_hash).toMatch(/^\$argon2id\$/);
    const sessions = await t.app.ctx.db.query<{ token_hash: string }>("SELECT token_hash FROM sessions");
    for (const s of sessions.rows) expect(s.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("logs out and invalidates the session", async () => {
    const token = await signUp(t, "carol@example.com");
    expect((await post("/api/auth/logout", {}, bearer(token))).statusCode).toBe(204);
    const me = await t.app.inject({ method: "GET", url: "/api/me", headers: bearer(token) });
    expect(me.statusCode).toBe(401);
  });

  it("resets a password with a single-use token and revokes sessions", async () => {
    const email = "dave@example.com";
    const oldToken = await signUp(t, email, "original passphrase");
    await post("/api/auth/password-reset/request", { email });
    const reset = tokenFromMail(t.mailer.lastTo(email)!.text, "pr");

    expect((await post("/api/auth/password-reset/confirm", { token: reset, newPassword: "brand new passphrase" })).statusCode).toBe(200);
    expect((await post("/api/auth/password-reset/confirm", { token: reset, newPassword: "another new passphrase" })).statusCode).toBe(400);
    expect((await t.app.inject({ method: "GET", url: "/api/me", headers: bearer(oldToken) })).statusCode).toBe(401);
    expect((await post("/api/auth/login", { email, password: "original passphrase" })).statusCode).toBe(401);
    expect((await post("/api/auth/login", { email, password: "brand new passphrase" })).statusCode).toBe(200);
  });

  it("changes a password and keeps only the current session", async () => {
    const email = "erin@example.com";
    const a = await signUp(t, email, "first passphrase!");
    const b = (await post("/api/auth/login", { email, password: "first passphrase!" })).json().token;
    const res = await post("/api/auth/change-password", { currentPassword: "first passphrase!", newPassword: "second passphrase!" }, bearer(a));
    expect(res.statusCode).toBe(200);
    expect((await t.app.inject({ method: "GET", url: "/api/me", headers: bearer(a) })).statusCode).toBe(200);
    expect((await t.app.inject({ method: "GET", url: "/api/me", headers: bearer(b) })).statusCode).toBe(401);
  });

  it("updates the profile", async () => {
    const token = await signUp(t, "frank@example.com");
    const res = await t.app.inject({ method: "PATCH", url: "/api/me", payload: { displayName: "Frank" }, headers: bearer(token) });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.displayName).toBe("Frank");
  });

  it("deletes the account and all its data after password confirmation", async () => {
    const token = await signUp(t, "gina@example.com", "gina passphrase!");
    await t.app.inject({ method: "POST", url: "/api/analyze", payload: { type: "text", content: "Your account has been suspended, verify now.", save: true }, headers: bearer(token) });
    expect((await t.app.inject({ method: "DELETE", url: "/api/me", payload: { password: "wrong" }, headers: bearer(token) })).statusCode).toBe(401);
    expect((await t.app.inject({ method: "DELETE", url: "/api/me", payload: { password: "gina passphrase!" }, headers: bearer(token) })).statusCode).toBe(204);
    expect((await t.app.inject({ method: "GET", url: "/api/me", headers: bearer(token) })).statusCode).toBe(401);
    const left = await t.app.ctx.db.query("SELECT 1 FROM users WHERE email = $1", ["gina@example.com"]);
    expect(left.rows).toEqual([]);
    const scans = await t.app.ctx.db.query<{ n: number }>("SELECT count(*)::int AS n FROM scans");
    expect(scans.rows[0]!.n).toBe(0);
  });

  it("rejects expired sessions", async () => {
    const token = await signUp(t, "henry@example.com");
    await t.app.ctx.db.query("UPDATE sessions SET expires_at = now() - interval '1 minute'");
    expect((await t.app.inject({ method: "GET", url: "/api/me", headers: bearer(token) })).statusCode).toBe(401);
  });
  it("resends verification only for unverified accounts, with a generic response", async () => {
    const email = "late@example.com";
    await post("/api/auth/register", { email, password: "late passphrase!" });
    const before = t.mailer.sent.length;
    const r1 = await post("/api/auth/resend-verification", { email });
    const r2 = await post("/api/auth/resend-verification", { email: "ghost@example.com" });
    expect(r1.statusCode).toBe(202);
    expect(r1.json()).toEqual(r2.json());
    expect(t.mailer.sent.length).toBe(before + 1);
    // Only the newest token works.
    const token = tokenFromMail(t.mailer.lastTo(email)!.text, "ev");
    expect((await post("/api/auth/verify-email", { token })).statusCode).toBe(200);
  });

  it("logs out everywhere", async () => {
    const email = "multi@example.com";
    const a = await signUp(t, email, "multi passphrase!");
    const b = (await post("/api/auth/login", { email, password: "multi passphrase!" })).json().token;
    expect((await post("/api/auth/logout-all", {}, bearer(a))).statusCode).toBe(204);
    for (const tok of [a, b]) expect((await t.app.inject({ method: "GET", url: "/api/me", headers: bearer(tok) })).statusCode).toBe(401);
  });
});
