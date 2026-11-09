import { randomUUID } from "node:crypto";
import type { Database, Queryable } from "../db/database.ts";
import type { Indicator, RiskLevel } from "../detection/types.ts";

/**
 * Repository layer: the only place that issues SQL. Every query is parameterised.
 * User-owned rows are always filtered by user_id in SQL (not after fetching).
 */

export interface UserRow {
  id: string;
  email: string;
  display_name: string | null;
  role: "user" | "admin";
  email_verified_at: Date | null;
  created_at: Date;
  updated_at: Date;
}
type UserWithHash = UserRow & { password_hash: string };

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

export class UserRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: { email: string; passwordHash: string; displayName: string | null }): Promise<UserRow | null> {
    const r = await this.db.query<UserRow>(
      `INSERT INTO users (id, email, email_normalized, password_hash, display_name)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (email_normalized) DO NOTHING
       RETURNING id, email, display_name, role, email_verified_at, created_at, updated_at`,
      [randomUUID(), input.email.trim(), normalizeEmail(input.email), input.passwordHash, input.displayName],
    );
    return r.rows[0] ?? null;
  }

  async findByEmailWithHash(email: string): Promise<UserWithHash | null> {
    const r = await this.db.query<UserWithHash>(
      `SELECT id, email, display_name, role, email_verified_at, created_at, updated_at, password_hash
       FROM users WHERE email_normalized = $1`,
      [normalizeEmail(email)],
    );
    return r.rows[0] ?? null;
  }

  async findById(id: string): Promise<UserRow | null> {
    const r = await this.db.query<UserRow>(
      `SELECT id, email, display_name, role, email_verified_at, created_at, updated_at FROM users WHERE id = $1`,
      [id],
    );
    return r.rows[0] ?? null;
  }

  async getPasswordHash(id: string): Promise<string | null> {
    const r = await this.db.query<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id = $1`, [id]);
    return r.rows[0]?.password_hash ?? null;
  }

  async updateProfile(id: string, displayName: string | null): Promise<UserRow | null> {
    const r = await this.db.query<UserRow>(
      `UPDATE users SET display_name = $2, updated_at = now() WHERE id = $1
       RETURNING id, email, display_name, role, email_verified_at, created_at, updated_at`,
      [id, displayName],
    );
    return r.rows[0] ?? null;
  }

  async setPassword(id: string, passwordHash: string) {
    await this.db.query(`UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1`, [id, passwordHash]);
  }

  async markVerified(id: string) {
    await this.db.query(`UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()), updated_at = now() WHERE id = $1`, [id]);
  }

  async setRole(email: string, role: "user" | "admin") {
    const r = await this.db.query(`UPDATE users SET role = $2, updated_at = now() WHERE email_normalized = $1`, [normalizeEmail(email), role]);
    return r.rowCount > 0;
  }

  async delete(id: string) {
    await this.db.query(`DELETE FROM users WHERE id = $1`, [id]);
  }

  async count() {
    const r = await this.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM users`);
    return Number(r.rows[0]?.n ?? 0);
  }
}

export interface SessionWithUser {
  session_id: string;
  expires_at: Date;
  user: UserRow;
}

export class SessionRepository {
  constructor(private readonly db: Queryable) {}

  async create(userId: string, tokenHash: string, expiresAt: Date, userAgent: string | null) {
    const id = randomUUID();
    await this.db.query(
      `INSERT INTO sessions (id, user_id, token_hash, expires_at, user_agent) VALUES ($1, $2, $3, $4, $5)`,
      [id, userId, tokenHash, expiresAt, userAgent?.slice(0, 200) ?? null],
    );
    return id;
  }

  async findValid(tokenHash: string): Promise<SessionWithUser | null> {
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT s.id AS session_id, s.expires_at, u.id, u.email, u.display_name, u.role, u.email_verified_at, u.created_at, u.updated_at
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [tokenHash],
    );
    const row = r.rows[0];
    if (!row) return null;
    const { session_id, expires_at, ...user } = row;
    return { session_id: session_id as string, expires_at: expires_at as Date, user: user as unknown as UserRow };
  }

  async touch(sessionId: string) {
    await this.db.query(`UPDATE sessions SET last_used_at = now() WHERE id = $1`, [sessionId]);
  }

  async delete(sessionId: string) {
    await this.db.query(`DELETE FROM sessions WHERE id = $1`, [sessionId]);
  }

  async deleteAllForUser(userId: string, exceptSessionId?: string) {
    await this.db.query(`DELETE FROM sessions WHERE user_id = $1 AND ($2::uuid IS NULL OR id <> $2::uuid)`, [userId, exceptSessionId ?? null]);
  }

  async purgeExpired() {
    await this.db.query(`DELETE FROM sessions WHERE expires_at <= now()`);
  }
}

export type TokenPurpose = "email_verification" | "password_reset";

export class UserTokenRepository {
  constructor(private readonly db: Queryable) {}

  async create(userId: string, purpose: TokenPurpose, tokenHash: string, expiresAt: Date) {
    // Only the newest token of each purpose stays valid.
    await this.db.query(`DELETE FROM user_tokens WHERE user_id = $1 AND purpose = $2`, [userId, purpose]);
    await this.db.query(
      `INSERT INTO user_tokens (id, user_id, purpose, token_hash, expires_at) VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), userId, purpose, tokenHash, expiresAt],
    );
  }

  /** Atomically consume a valid token. Returns the user id, or null if invalid/expired/used. */
  async consume(purpose: TokenPurpose, tokenHash: string): Promise<string | null> {
    const r = await this.db.query<{ user_id: string }>(
      `UPDATE user_tokens SET used_at = now()
       WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()
       RETURNING user_id`,
      [tokenHash, purpose],
    );
    return r.rows[0]?.user_id ?? null;
  }
}

/** Indicator as persisted: evidence is removed so no submitted content is stored. */
export type StoredIndicator = Omit<Indicator, "evidence">;

export interface ScanRow {
  id: string;
  input_type: string;
  content_length: number;
  language: string;
  risk_level: RiskLevel;
  indicators: StoredIndicator[];
  explanation: string;
  recommendations: string[];
  analysis_method: string;
  ai_status: string;
  created_at: Date;
}

export interface ScanFilters {
  riskLevel?: RiskLevel | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
  limit: number;
  offset: number;
}

const SCAN_COLUMNS = `id, input_type, content_length, language, risk_level, indicators, explanation, recommendations, analysis_method, ai_status, created_at`;

export class ScanRepository {
  constructor(private readonly db: Queryable) {}

  async create(userId: string, scan: Omit<ScanRow, "id" | "created_at">): Promise<ScanRow> {
    const r = await this.db.query<ScanRow>(
      `INSERT INTO scans (id, user_id, input_type, content_length, language, risk_level, indicators, explanation, recommendations, analysis_method, ai_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, $10, $11)
       RETURNING ${SCAN_COLUMNS}`,
      [
        randomUUID(), userId, scan.input_type, scan.content_length, scan.language, scan.risk_level,
        JSON.stringify(scan.indicators), scan.explanation, JSON.stringify(scan.recommendations), scan.analysis_method, scan.ai_status,
      ],
    );
    return r.rows[0]!;
  }

  async list(userId: string, f: ScanFilters): Promise<{ items: ScanRow[]; total: number }> {
    const where = `user_id = $1 AND ($2::text IS NULL OR risk_level = $2) AND ($3::timestamptz IS NULL OR created_at >= $3) AND ($4::timestamptz IS NULL OR created_at <= $4)`;
    const params = [userId, f.riskLevel ?? null, f.from ?? null, f.to ?? null];
    const [items, total] = await Promise.all([
      this.db.query<ScanRow>(`SELECT ${SCAN_COLUMNS} FROM scans WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT $5 OFFSET $6`, [...params, f.limit, f.offset]),
      this.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM scans WHERE ${where}`, params),
    ]);
    return { items: items.rows, total: Number(total.rows[0]?.n ?? 0) };
  }

  async findOwned(userId: string, scanId: string): Promise<ScanRow | null> {
    const r = await this.db.query<ScanRow>(`SELECT ${SCAN_COLUMNS} FROM scans WHERE id = $1 AND user_id = $2`, [scanId, userId]);
    return r.rows[0] ?? null;
  }

  async deleteOwned(userId: string, scanId: string) {
    const r = await this.db.query(`DELETE FROM scans WHERE id = $1 AND user_id = $2`, [scanId, userId]);
    return r.rowCount > 0;
  }

  async deleteAllOwned(userId: string) {
    const r = await this.db.query(`DELETE FROM scans WHERE user_id = $1`, [userId]);
    return r.rowCount;
  }

  async count() {
    const r = await this.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM scans`);
    return Number(r.rows[0]?.n ?? 0);
  }
}

export type FeedbackType = "false_positive" | "missed_scam" | "unclear_explanation" | "other";
export type FeedbackStatus = "open" | "reviewed" | "dismissed";

export interface FeedbackRow {
  id: string;
  user_id: string | null;
  scan_id: string | null;
  analysis_id: string | null;
  feedback_type: FeedbackType;
  reported_risk_level: RiskLevel | null;
  comment: string | null;
  status: FeedbackStatus;
  reviewed_at: Date | null;
  created_at: Date;
}

const FEEDBACK_COLUMNS = `id, user_id, scan_id, analysis_id, feedback_type, reported_risk_level, comment, status, reviewed_at, created_at`;

export class FeedbackRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: Omit<FeedbackRow, "id" | "status" | "reviewed_at" | "created_at">): Promise<FeedbackRow> {
    const r = await this.db.query<FeedbackRow>(
      `INSERT INTO feedback (id, user_id, scan_id, analysis_id, feedback_type, reported_risk_level, comment)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${FEEDBACK_COLUMNS}`,
      [randomUUID(), input.user_id, input.scan_id, input.analysis_id, input.feedback_type, input.reported_risk_level, input.comment],
    );
    return r.rows[0]!;
  }

  async list(f: { status?: FeedbackStatus | undefined; type?: FeedbackType | undefined; limit: number; offset: number }) {
    const where = `($1::text IS NULL OR status = $1) AND ($2::text IS NULL OR feedback_type = $2)`;
    const params = [f.status ?? null, f.type ?? null];
    const [items, total] = await Promise.all([
      this.db.query<FeedbackRow>(`SELECT ${FEEDBACK_COLUMNS} FROM feedback WHERE ${where} ORDER BY created_at DESC LIMIT $3 OFFSET $4`, [...params, f.limit, f.offset]),
      this.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM feedback WHERE ${where}`, params),
    ]);
    return { items: items.rows, total: Number(total.rows[0]?.n ?? 0) };
  }

  async setStatus(id: string, status: FeedbackStatus, reviewerId: string): Promise<FeedbackRow | null> {
    const r = await this.db.query<FeedbackRow>(
      `UPDATE feedback SET status = $2, reviewed_by = $3, reviewed_at = now() WHERE id = $1 RETURNING ${FEEDBACK_COLUMNS}`,
      [id, status, reviewerId],
    );
    return r.rows[0] ?? null;
  }

  async countRecentByUser(userId: string, sinceMinutes: number) {
    const r = await this.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM feedback WHERE user_id = $1 AND created_at > now() - ($2::int * interval '1 minute')`,
      [userId, sinceMinutes],
    );
    return Number(r.rows[0]?.n ?? 0);
  }

  async summary() {
    const r = await this.db.query<{ feedback_type: string; status: string; n: string }>(
      `SELECT feedback_type, status, count(*)::text AS n FROM feedback GROUP BY feedback_type, status ORDER BY feedback_type, status`,
    );
    return r.rows.map((row) => ({ feedbackType: row.feedback_type, status: row.status, count: Number(row.n) }));
  }
}

export const ARTICLE_CATEGORIES = ["phishing", "fake_shopping", "sms_scams", "email_fraud", "account_impersonation", "payment_safety"] as const;
export type ArticleCategory = (typeof ARTICLE_CATEGORIES)[number];

export interface ArticleRow {
  id: string;
  slug: string;
  title: string;
  category: ArticleCategory;
  language: "en" | "ar";
  summary: string;
  body: string;
  status: "draft" | "published";
  published_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const ARTICLE_COLUMNS = `id, slug, title, category, language, summary, body, status, published_at, created_at, updated_at`;

export class ArticleRepository {
  constructor(private readonly db: Queryable) {}

  async list(f: { category?: ArticleCategory | undefined; language?: string | undefined; includeDrafts: boolean; limit: number; offset: number }) {
    const where = `($1::boolean OR status = 'published') AND ($2::text IS NULL OR category = $2) AND ($3::text IS NULL OR language = $3)`;
    const params = [f.includeDrafts, f.category ?? null, f.language ?? null];
    const [items, total] = await Promise.all([
      this.db.query<ArticleRow>(`SELECT ${ARTICLE_COLUMNS} FROM articles WHERE ${where} ORDER BY published_at DESC NULLS LAST, created_at DESC LIMIT $4 OFFSET $5`, [...params, f.limit, f.offset]),
      this.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM articles WHERE ${where}`, params),
    ]);
    return { items: items.rows, total: Number(total.rows[0]?.n ?? 0) };
  }

  async findBySlugOrId(idOrSlug: string, includeDrafts: boolean): Promise<ArticleRow | null> {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrSlug);
    const r = await this.db.query<ArticleRow>(
      `SELECT ${ARTICLE_COLUMNS} FROM articles WHERE ${isUuid ? "id = $1::uuid" : "slug = $1"} AND ($2::boolean OR status = 'published')`,
      [idOrSlug, includeDrafts],
    );
    return r.rows[0] ?? null;
  }

  async create(input: { slug: string; title: string; category: ArticleCategory; language: "en" | "ar"; summary: string; body: string; status: "draft" | "published"; createdBy: string | null }): Promise<ArticleRow | null> {
    const r = await this.db.query<ArticleRow>(
      `INSERT INTO articles (id, slug, title, category, language, summary, body, status, published_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $8 = 'published' THEN now() END, $9)
       ON CONFLICT (slug) DO NOTHING RETURNING ${ARTICLE_COLUMNS}`,
      [randomUUID(), input.slug, input.title, input.category, input.language, input.summary, input.body, input.status, input.createdBy],
    );
    return r.rows[0] ?? null;
  }

  async update(id: string, patch: Partial<Pick<ArticleRow, "slug" | "title" | "category" | "language" | "summary" | "body">>): Promise<ArticleRow | null> {
    const r = await this.db.query<ArticleRow>(
      `UPDATE articles SET
         slug = COALESCE($2, slug), title = COALESCE($3, title), category = COALESCE($4, category),
         language = COALESCE($5, language), summary = COALESCE($6, summary), body = COALESCE($7, body), updated_at = now()
       WHERE id = $1 RETURNING ${ARTICLE_COLUMNS}`,
      [id, patch.slug ?? null, patch.title ?? null, patch.category ?? null, patch.language ?? null, patch.summary ?? null, patch.body ?? null],
    );
    return r.rows[0] ?? null;
  }

  async setStatus(id: string, status: "draft" | "published"): Promise<ArticleRow | null> {
    const r = await this.db.query<ArticleRow>(
      `UPDATE articles SET status = $2, published_at = CASE WHEN $2 = 'published' THEN COALESCE(published_at, now()) ELSE NULL END, updated_at = now()
       WHERE id = $1 RETURNING ${ARTICLE_COLUMNS}`,
      [id, status],
    );
    return r.rows[0] ?? null;
  }

  async delete(id: string) {
    const r = await this.db.query(`DELETE FROM articles WHERE id = $1`, [id]);
    return r.rowCount > 0;
  }
}

export class AuditLogRepository {
  constructor(private readonly db: Queryable) {}

  async record(entry: { actorId: string | null; action: string; targetType?: string; targetId?: string; metadata?: Record<string, unknown> }) {
    await this.db.query(
      `INSERT INTO audit_logs (id, actor_id, action, target_type, target_id, metadata) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [randomUUID(), entry.actorId, entry.action, entry.targetType ?? null, entry.targetId ?? null, JSON.stringify(entry.metadata ?? {})],
    );
  }

  async list(limit: number, offset: number) {
    const r = await this.db.query(
      `SELECT a.id, a.actor_id, u.email AS actor_email, a.action, a.target_type, a.target_id, a.metadata, a.created_at
       FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    return r.rows;
  }
}

export class StatsRepository {
  constructor(private readonly db: Queryable) {}

  async increment(stat: { inputType: string; riskLevel: string; analysisMethod: string }) {
    await this.db.query(
      `INSERT INTO analysis_daily_stats (day, input_type, risk_level, analysis_method, count) VALUES (current_date, $1, $2, $3, 1)
       ON CONFLICT (day, input_type, risk_level, analysis_method) DO UPDATE SET count = analysis_daily_stats.count + 1`,
      [stat.inputType, stat.riskLevel, stat.analysisMethod],
    );
  }

  async summary(days: number) {
    const r = await this.db.query<{ day: string; input_type: string; risk_level: string; analysis_method: string; count: number }>(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, input_type, risk_level, analysis_method, count FROM analysis_daily_stats
       WHERE day > current_date - $1::int ORDER BY day DESC, input_type, risk_level`,
      [days],
    );
    return r.rows;
  }
}

export interface Repositories {
  users: UserRepository;
  sessions: SessionRepository;
  tokens: UserTokenRepository;
  scans: ScanRepository;
  feedback: FeedbackRepository;
  articles: ArticleRepository;
  audit: AuditLogRepository;
  stats: StatsRepository;
}

export function createRepositories(db: Database): Repositories {
  return {
    users: new UserRepository(db),
    sessions: new SessionRepository(db),
    tokens: new UserTokenRepository(db),
    scans: new ScanRepository(db),
    feedback: new FeedbackRepository(db),
    articles: new ArticleRepository(db),
    audit: new AuditLogRepository(db),
    stats: new StatsRepository(db),
  };
}
