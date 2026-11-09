import { describe, expect, it } from "vitest";
import { createDatabase } from "../../server/db/database.ts";
import { migrate } from "../../server/db/migrate.ts";
import { createRepositories } from "../../server/repositories/index.ts";

// Runs against PGlite: real PostgreSQL compiled to WebAssembly, in memory.
describe("database", () => {
  it("applies migrations once and is idempotent", async () => {
    const db = await createDatabase({});
    try {
      expect(await migrate(db)).toEqual(["001_initial_schema.sql"]);
      expect(await migrate(db)).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it("cascades user deletion to sessions, tokens, scans, and feedback; keeps audit logs", async () => {
    const db = await createDatabase({});
    try {
      await migrate(db);
      const repos = createRepositories(db);
      const user = (await repos.users.create({ email: "x@example.com", passwordHash: "h", displayName: null }))!;
      await repos.sessions.create(user.id, "a".repeat(64), new Date(Date.now() + 1e6), null);
      await repos.tokens.create(user.id, "password_reset", "b".repeat(64), new Date(Date.now() + 1e6));
      const scan = await repos.scans.create(user.id, { input_type: "text", content_length: 5, language: "en", risk_level: "low", indicators: [], explanation: "e", recommendations: ["r"], analysis_method: "rules", ai_status: "not_configured" });
      await repos.feedback.create({ user_id: user.id, scan_id: scan.id, analysis_id: null, feedback_type: "other", reported_risk_level: null, comment: null });
      await repos.audit.record({ actorId: user.id, action: "test.action" });

      await repos.users.delete(user.id);
      for (const table of ["sessions", "user_tokens", "scans", "feedback"]) {
        const r = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
        expect(r.rows[0]!.n).toBe(0);
      }
      const audit = await db.query<{ actor_id: string | null }>("SELECT actor_id FROM audit_logs");
      expect(audit.rows).toEqual([{ actor_id: null }]);
    } finally {
      await db.close();
    }
  });

  it("enforces unique emails case-insensitively and valid enum values", async () => {
    const db = await createDatabase({});
    try {
      await migrate(db);
      const repos = createRepositories(db);
      expect(await repos.users.create({ email: "Case@Example.com", passwordHash: "h", displayName: null })).not.toBeNull();
      expect(await repos.users.create({ email: "case@example.COM", passwordHash: "h", displayName: null })).toBeNull();
      await expect(db.query("UPDATE users SET role = 'superuser'")).rejects.toThrow();
    } finally {
      await db.close();
    }
  });

  it("consumes one-time tokens atomically and only once", async () => {
    const db = await createDatabase({});
    try {
      await migrate(db);
      const repos = createRepositories(db);
      const user = (await repos.users.create({ email: "t@example.com", passwordHash: "h", displayName: null }))!;
      await repos.tokens.create(user.id, "email_verification", "c".repeat(64), new Date(Date.now() + 1e6));
      expect(await repos.tokens.consume("password_reset", "c".repeat(64))).toBeNull(); // wrong purpose
      expect(await repos.tokens.consume("email_verification", "c".repeat(64))).toBe(user.id);
      expect(await repos.tokens.consume("email_verification", "c".repeat(64))).toBeNull();
      await repos.tokens.create(user.id, "email_verification", "d".repeat(64), new Date(Date.now() - 1000));
      expect(await repos.tokens.consume("email_verification", "d".repeat(64))).toBeNull(); // expired
    } finally {
      await db.close();
    }
  });
});

describe("database adapter", () => {
  it("reports rowCount for SELECT, INSERT, UPDATE, and DELETE like node-postgres", async () => {
    const db = await createDatabase({});
    try {
      await db.query("CREATE TABLE t (n int)");
      expect((await db.query("INSERT INTO t VALUES (1), (2), (3)")).rowCount).toBe(3);
      expect((await db.query("SELECT * FROM t")).rowCount).toBe(3);
      expect((await db.query("UPDATE t SET n = n + 1 WHERE n > 1")).rowCount).toBe(2);
      expect((await db.query("DELETE FROM t WHERE n = 1")).rowCount).toBe(1);
      expect((await db.query("SELECT * FROM t WHERE n = 99")).rowCount).toBe(0);
    } finally {
      await db.close();
    }
  });
});
