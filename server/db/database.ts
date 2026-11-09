import { mkdirSync } from "node:fs";
import pg from "pg";
import { PGlite } from "@electric-sql/pglite";

/**
 * Minimal database abstraction shared by the PostgreSQL (`pg`) and PGlite drivers.
 * All SQL in this codebase is parameterised ($1, $2, ...) - never string-interpolated.
 */
export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface Database extends Queryable {
  readonly kind: "postgres" | "pglite";
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  /** Run a multi-statement script plus one parameterised statement atomically (migrations). */
  runScriptAtomically(script: string, then: { sql: string; params: unknown[] }): Promise<void>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

class PostgresDatabase implements Database {
  readonly kind = "postgres" as const;
  constructor(private readonly pool: pg.Pool) {}

  async query<T>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const r = await this.pool.query(sql, params);
    return { rows: r.rows as T[], rowCount: r.rowCount ?? 0 };
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const tx: Queryable = {
        query: async <R>(sql: string, params: unknown[] = []) => {
          const r = await client.query(sql, params);
          return { rows: r.rows as R[], rowCount: r.rowCount ?? 0 };
        },
      };
      const result = await fn(tx);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async runScriptAtomically(script: string, then: { sql: string; params: unknown[] }) {
    await this.transaction(async (tx) => {
      await tx.query(script); // simple-query protocol allows multiple statements
      await tx.query(then.sql, then.params);
    });
  }

  async ping() {
    try {
      await this.pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  close() {
    return this.pool.end();
  }
}

class PgliteDatabase implements Database {
  readonly kind = "pglite" as const;
  constructor(private readonly db: PGlite) {}

  async query<T>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const r = await this.db.query<T>(sql, params);
    return { rows: r.rows, rowCount: Math.max(r.affectedRows ?? 0, r.rows.length) };
  }

  async runScriptAtomically(script: string, then: { sql: string; params: unknown[] }) {
    await this.db.transaction(async (t) => {
      await t.exec(script);
      await t.query(then.sql, then.params);
    });
  }

  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return this.db.transaction(async (t) =>
      fn({
        query: async <R>(sql: string, params: unknown[] = []) => {
          const r = await t.query<R>(sql, params);
          return { rows: r.rows, rowCount: Math.max(r.affectedRows ?? 0, r.rows.length) };
        },
      }),
    );
  }

  async ping() {
    try {
      await this.db.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  close() {
    return this.db.close();
  }
}

export interface DatabaseOptions {
  url?: string;
  /** Directory for a persistent PGlite database. Omit for an in-memory database. */
  pgliteDataDir?: string;
}

export async function createDatabase(options: DatabaseOptions): Promise<Database> {
  if (options.url) {
    const pool = new pg.Pool({ connectionString: options.url, max: 10, idleTimeoutMillis: 30_000 });
    return new PostgresDatabase(pool);
  }
  if (options.pgliteDataDir) mkdirSync(options.pgliteDataDir, { recursive: true });
  const db = options.pgliteDataDir ? new PGlite(options.pgliteDataDir) : new PGlite();
  await db.waitReady;
  return new PgliteDatabase(db);
}
