# Database Schema

PostgreSQL. Defined in `server/db/migrations/001_initial_schema.sql`. Applied by `npm run db:migrate` (forward-only, each migration in a transaction, tracked in `schema_migrations`). The embedded PGlite database used in development migrates automatically; a real PostgreSQL database migrates only when you run the command or set `DB_AUTO_MIGRATE=true`. **No migration drops or rewrites existing data.**

## Privacy rule

Raw submitted messages, URLs, emails, images, and OCR text are **never stored**. Saved scans keep only the input type, content length, detected language, result, and indicator metadata **without evidence excerpts**. Guest analyses are not stored at all; they only increment anonymous daily counters.

## Tables

### `users`
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| email | text | as entered |
| email_normalized | text UNIQUE | lowercase; case-insensitive uniqueness |
| password_hash | text | Argon2id PHC string |
| display_name | text null | |
| role | text | `user` \| `admin` (CHECK) |
| email_verified_at | timestamptz null | |
| created_at, updated_at | timestamptz | |

### `sessions`
id uuid PK · user_id → users **ON DELETE CASCADE** · token_hash text UNIQUE (SHA-256 of the bearer token) · created_at · last_used_at · expires_at · user_agent (≤200 chars).
Indexes: `user_id`, `expires_at`. Expired rows are purged on login.

### `user_tokens`
Single-use email-verification and password-reset tokens. id · user_id → users CASCADE · purpose (`email_verification` \| `password_reset`) · token_hash UNIQUE · expires_at · used_at · created_at. Creating a token deletes older ones of the same purpose. Consumption is a single atomic `UPDATE … WHERE used_at IS NULL AND expires_at > now() RETURNING`.

### `scans`
id · user_id → users CASCADE · input_type (`text`\|`url`\|`email`\|`image`) · content_length int ≥ 0 · language · risk_level (`low`\|`medium`\|`high`\|`unknown`) · indicators jsonb (no evidence) · explanation · recommendations jsonb · analysis_method (`rules` \| `rules+ml`; legacy `rules+ai`) · ai_status (deprecated; new scans store `not_configured`) · ml_status (null) · model_version (null) · created_at. `ml_status` and `model_version` were added by `002_ml_classifier.sql` (additive, nullable).
Indexes: `(user_id, created_at DESC)`, `(user_id, risk_level)`. All queries filter by `user_id` in SQL.

### `feedback`
id · user_id → users CASCADE (null for guests) · scan_id → scans **SET NULL** · analysis_id text · feedback_type (`false_positive`\|`missed_scam`\|`unclear_explanation`\|`other`) · reported_risk_level · comment (≤1000, plain text) · status (`open`\|`reviewed`\|`dismissed`) · reviewed_by → users SET NULL · reviewed_at · created_at.
Index: `(status, created_at DESC)`, `user_id`.

### `articles`
id · slug UNIQUE · title · category (`phishing`\|`fake_shopping`\|`sms_scams`\|`email_fraud`\|`account_impersonation`\|`payment_safety`) · language (`en`\|`ar`) · summary · body (plain text) · status (`draft`\|`published`) · published_at · created_by → users SET NULL · created_at · updated_at.
Index: `(status, category)`. Seed content: `server/db/seed.ts` (7 articles, idempotent by slug, `npm run db:seed`).

### `audit_logs`
id · actor_id → users **SET NULL** (log survives account deletion) · action · target_type · target_id · metadata jsonb · created_at. Index: `created_at DESC`.

### `analysis_daily_stats`
Anonymous counters: (day, input_type, risk_level, analysis_method) PK · count. No user id, no content.

## Deletion behaviour

| Action | Effect |
|---|---|
| Delete account (`DELETE /api/me`) | Removes user, sessions, tokens, scans, feedback. Audit entries keep the action with `actor_id = NULL`. |
| Delete scan | Removes the scan; linked feedback keeps the report with `scan_id = NULL`. |
| Delete all scans | Removes only the caller's scans. |

## Retention

Not yet automated: there is no scheduled job that purges old feedback, audit logs, or stats. See `docs/BACKEND_PROGRESS.md`.
