import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Database } from "./database.ts";

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");
const NAME_PATTERN = /^\d{3}_[a-z0-9_]+\.sql$/;

/**
 * Apply pending forward-only migrations in filename order. Each migration runs in its own
 * transaction together with its bookkeeping row. Migrations never drop existing data.
 */
export async function migrate(db: Database): Promise<string[]> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const applied = new Set(
    (await db.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name),
  );
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => NAME_PATTERN.test(f))
    .sort();

  const newlyApplied: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    await db.runScriptAtomically(sql, { sql: "INSERT INTO schema_migrations (name) VALUES ($1)", params: [file] });
    newlyApplied.push(file);
  }
  return newlyApplied;
}
