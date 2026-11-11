# API Documentation

Base path `/api`. JSON in and out unless noted. Authentication: `Authorization: Bearer <token>` from `POST /api/auth/login`.
The frontend-oriented guide with examples is [`FRONTEND_INTEGRATION.md`](../FRONTEND_INTEGRATION.md); this file is the field-level reference.

## Conventions

**Error body** (every non-2xx JSON response):

```json
{ "error": { "code": "STRING_CODE", "message": "User-safe message.", "details": "optional" } }
```

| Code | Status | Meaning |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Body/query/params failed validation; `details: [{ path, message }]` |
| `BAD_REQUEST` | 400 | Malformed request (e.g. invalid JSON) |
| `INVALID_TOKEN` | 400 | Verification/reset token invalid, expired, or used |
| `UNAUTHORIZED` | 401 | Missing/invalid/expired bearer token |
| `INVALID_CREDENTIALS` | 401 | Wrong email or password (generic by design) |
| `FORBIDDEN` | 403 | Not an admin |
| `EMAIL_NOT_VERIFIED` | 403 | Login before verifying (when `REQUIRE_EMAIL_VERIFICATION=true`) |
| `NOT_FOUND` | 404 | Unknown route or resource (also returned for other users' resources) |
| `SLUG_TAKEN` | 409 | Article slug already exists |
| `PAYLOAD_TOO_LARGE` / `FILE_TOO_LARGE` | 413 | JSON body > 64 KB / upload > `UPLOAD_MAX_BYTES` |
| `UNSUPPORTED_MEDIA_TYPE` / `UNSUPPORTED_FILE_TYPE` | 415 | Wrong Content-Type / not PNG, JPEG, WebP |
| `OCR_FAILED` | 422 | Image could not be read |
| `RATE_LIMITED` | 429 | `details.retryAfterSeconds`; `Retry-After` header |
| `INTERNAL_ERROR` | 500 | Unexpected; details are logged server-side, never returned |
| `OCR_DISABLED` / `OCR_BUSY` | 503 | OCR off / queue full |
| `OCR_TIMEOUT` | 504 | OCR exceeded `OCR_TIMEOUT_MS` |

**Rate limits** (per client IP, per process, in memory): global 120/min; analyze 20/min; image 6/min; login/register/verify/reset-confirm/change-password/delete-account 10 per 15 min; resend-verification and reset-request 5/hour; feedback 10/hour (plus 20/hour per signed-in user).

## Analysis

### `POST /api/analyze`

Body:

| Field | Type | Rules |
|---|---|---|
| `type` | `"text" \| "url" \| "email"` | required |
| `content` | string | ≤ 10,000 chars; non-blank unless `type=email` with `email.subject`/`email.body` |
| `email` | `{ from?: string≤320, replyTo?: string≤320, subject?: string≤998, body?: string≤10000 }` | only with `type=email` |
| `save` | boolean | default `false`; `true` requires auth |

Unknown fields are rejected. For `type=url`, the content must parse as an address (a missing scheme is treated as `http://`). Dangerous schemes such as `javascript:` are accepted and flagged with `URL_UNSAFE_SCHEME`.

Response `200`:

| Field | Type | Notes |
|---|---|---|
| `analysisId` | uuid | Random per analysis (not stored for guests) |
| `status` | `"completed"` | |
| `inputType` | `"text" \| "url" \| "email" \| "image"` | |
| `riskLevel` / `risk` | `"low" \| "medium" \| "high" \| "unknown"` | `risk` is an alias for the existing frontend |
| `explanation` / `summary` | string | Deterministic; `summary` is an alias |
| `warnings` | string[] | `"<description> (“<evidence>”)"`, one per indicator |
| `indicators` | `{ code, category, severity: "low"\|"medium"\|"high", description, evidence, source: "rules"\|"url"\|"email"\|"ml" }[]` | All warning signs shown to the user. At most one `source: "ml"` entry (`ML_SCAM_LIKE_WORDING`, category `statistical`, severity `low` or `medium`) |
| `ruleIndicators` | same shape | Rule, URL, and email-sender indicators only |
| `recommendations` | string[] (1–6) | |
| `analysisMethod` | `"rules" \| "rules+ml"` | `rules+ml` only when the ML model actually produced the score |
| `modelVersion` | string \| null | e.g. `scamshield-text-v1.0.0`; `null` when the model did not run |
| `mlPrediction` | `{ status, reason, modelVersion, probability, band, label, decisionThreshold: 0.5, truncated, latencyMs, interpretation }` | `status`: `used` \| `not_applicable` \| `unavailable` \| `failed`. `reason`: `input_type_url`, `insufficient_content`, `unsupported_language`, `input_too_large`, `disabled`, `model_unavailable`, `timeout`, `queue_full`, `engine_error`, `invalid_output`. `probability` (0–1, 4 dp) and `band` (`low` < 0.2 \| `uncertain` \| `elevated` ≥ 0.5 \| `strong` ≥ 0.9) are `null` unless `used`. Not a calibrated scam probability |
| `modelExplanation` | `{ method: "linear_term_contributions", towardSuspicious: {term, display, weight}[], towardLegitimate: {…}[], note }` \| null | Normalised terms from the submission and their additive log-odds contribution |
| `hybrid` | `{ ruleRiskLevel, adjustment: "none"\|"raised_by_ml"\|"unknown_without_ml", agreement: "agree"\|"ml_more_suspicious"\|"ml_less_suspicious"\|"ml_not_used", reasons: string[], mlOnlyCanRaise }` | How the final level was reached (see `server/risk/hybrid.ts`) |
| `ai` | `{ status: "not_configured", provider: null, model: null, summary: null, reason: "external_ai_removed" }` | **Deprecated.** External AI was removed; kept for older clients |
| `language` | `"en" \| "ar" \| "mixed" \| "unknown"` | |
| `email` | `{ senderVerified: false, fromAddress, note }` | email only |
| `disclaimer` | string | |
| `saved`, `scanId` | boolean, uuid \| null | |
| `createdAt` | ISO date | |

There are no confidence percentages by design (see `docs/BACKEND_PROGRESS.md` → detection approach).

### `POST /api/analyze/image`

`multipart/form-data`: `file` (exactly one; PNG/JPEG/WebP by magic bytes; ≤ `UPLOAD_MAX_BYTES`), optional field `save=true`. Response: as above with `inputType: "image"` plus `ocr: { engine, characters, confidence, extractedText, truncated }`. The image is processed in memory and discarded; extracted text is not stored.

## Auth

| Method & path | Body | Response |
|---|---|---|
| `POST /auth/register` | `{ email, password (10–128), displayName? (1–80) }` | `202 { status: "accepted", message }` (identical for existing emails) |
| `GET /auth/verify-email?token=` | — | `200 text/plain` confirmation, or `400` text |
| `POST /auth/verify-email` | `{ token }` | `200 { status: "verified" }` |
| `POST /auth/resend-verification` | `{ email }` | `202` (always) |
| `POST /auth/login` | `{ email, password }` | `200 { token, tokenType: "Bearer", expiresAt, user }` |
| `POST /auth/logout` | — (auth) | `204` |
| `POST /auth/logout-all` | — (auth) | `204` |
| `POST /auth/password-reset/request` | `{ email }` | `202` (always). Token valid 30 min |
| `POST /auth/password-reset/confirm` | `{ token, newPassword }` | `200`; revokes all sessions; marks email verified |
| `POST /auth/change-password` | `{ currentPassword, newPassword }` (auth) | `200`; revokes other sessions |

`user`: `{ id, email, displayName, role, emailVerified, createdAt }`. Sessions last `SESSION_TTL_HOURS` (default 168 h).

## Profile

| | Body | Response |
|---|---|---|
| `GET /me` | — | `{ user }` |
| `PATCH /me` | `{ displayName: string(1–80) \| null }` | `{ user }` |
| `DELETE /me` | `{ password }` | `204`; cascades sessions, tokens, scans, feedback |

## Scan history (auth required; always scoped to the caller)

| | Query/body | Response |
|---|---|---|
| `GET /scans` | `riskLevel?`, `from?`, `to?` (ISO date or datetime; date-only `to` is inclusive of the whole day), `limit` 1–100 (20), `offset` (0) | `{ items: Scan[], total, limit, offset }` newest first |
| `GET /scans/:id` | | `{ scan }` |
| `GET /scans/:id/report` | `format=txt\|json` (txt) | attachment download |
| `DELETE /scans/:id` | | `204` |
| `DELETE /scans` | | `{ deleted }` |

`Scan`: `{ scanId, inputType, contentLength, language, riskLevel, indicators: (indicator without evidence)[], explanation, recommendations, analysisMethod, aiStatus (deprecated), mlStatus, modelVersion, createdAt }`. `mlStatus`/`modelVersion` are `null` for scans saved before the ML model.

## Feedback

`POST /feedback` (auth optional): `{ feedbackType: "false_positive"|"missed_scam"|"unclear_explanation"|"other", scanId?: uuid, analysisId?: uuid, reportedRiskLevel?, comment?: string≤1000 }`. One of `scanId`/`analysisId` is required; `scanId` requires auth and ownership. → `201 { feedbackId, status: "received" }`.

## Articles (public)

- `GET /articles?category=&language=en|ar&limit=1–50&offset=` → `{ items (no body), total, limit, offset, categories }`
- `GET /articles/:slugOrId` → `{ article }` (published only)

Article: `{ id, slug, title, category, language, summary, body, status, publishedAt, updatedAt }`. `body` is plain text.

## Admin (role `admin`)

| | Notes |
|---|---|
| `GET /admin/metrics?days=1–365` | `{ periodDays, totals: { analyses, byRiskLevel, byInputType, byMethod }, daily[], users, savedScans, feedback[] }` — counts only |
| `GET /admin/health` | `{ status, uptimeSeconds, environment, database, ml: { enabled, engine, state, modelVersion, reason, workers, queueDepth, algorithm }, externalAi: { configured: false, note }, ocr, mail, rateLimiting, node }` |
| `GET /admin/rules` | `{ text[], url[], email[] }` rule definitions |
| `GET /admin/feedback?status=&type=&limit=&offset=` | comments included; user ids are not (only `hasAccount`) |
| `PATCH /admin/feedback/:id` | `{ status: "open"|"reviewed"|"dismissed" }` — audited |
| `GET /admin/articles`, `GET /admin/articles/:id` | includes drafts |
| `POST /admin/articles` | `{ slug (kebab-case 3–100), title 3–200, category, language, summary 10–500, body 20–20000, status? }` → `201` — audited |
| `PATCH /admin/articles/:id` | partial — audited |
| `POST /admin/articles/:id/publish`, `/unpublish` | audited |
| `DELETE /admin/articles/:id` | `204` — audited |
| `GET /admin/audit-logs?limit=&offset=` | `{ items: [{ id, actor_id, actor_email, action, target_type, target_id, metadata, created_at }] }` |

## Health

`GET /health` → `200 { status: "ok", capabilities: { analysis, ml, ai, ocr, accounts } }` or `503` with `status: "degraded"` when the database is unreachable. `ml` = the ML model is loaded and ready; `ai` is deprecated and always `false`.

## Detection rule catalogue

| Text rules (`source: rules`) | Severity |
|---|---|
| URGENT_LANGUAGE, THREATENING_LANGUAGE, SECRECY_REQUEST | medium |
| PASSWORD_REQUEST, OTP_REQUEST, BANKING_INFO_REQUEST, CARD_INFO_REQUEST, UNUSUAL_PAYMENT_METHOD, INVESTMENT_FRAUD | high |
| PERSONAL_INFO_REQUEST, PAYMENT_DEMAND, IMPERSONATION, FAKE_DELIVERY, ACCOUNT_SUSPENSION, PRIZE_LOTTERY, JOB_SCAM, PHISHING_CALL_TO_ACTION, HIDDEN_CHARACTERS, MIXED_SCRIPT_WORD | medium |
| PROMPT_INJECTION_ATTEMPT | low |

| URL rules (`source: url`) | Severity |
|---|---|
| URL_UNSAFE_SCHEME, URL_EMBEDDED_CREDENTIALS, URL_MIXED_SCRIPT_DOMAIN, URL_BRAND_LOOKALIKE, URL_BRAND_IN_SUBDOMAIN | high |
| URL_IP_HOST, URL_PUNYCODE, URL_BRAND_MISMATCH, URL_DOMAIN_IN_SUBDOMAIN, URL_EXCESSIVE_SUBDOMAINS, URL_UNUSUAL_CHARACTERS, URL_REDIRECT_PARAMETER, URL_EMAIL_IN_PARAMETERS, URL_DECEPTIVE_DOMAIN_WORDS | medium |
| URL_SHORTENER, URL_RISKY_TLD, URL_SENSITIVE_KEYWORDS, URL_EXCESSIVE_LENGTH, URL_MANY_HYPHENS, URL_NON_STANDARD_PORT, URL_NOT_HTTPS | low |

| Email rules (`source: email`) | Severity |
|---|---|
| EMAIL_SENDER_BRAND_MISMATCH, EMAIL_LOOKALIKE_SENDER_DOMAIN | high |
| EMAIL_DISPLAY_NAME_SPOOF, EMAIL_FREE_MAIL_ORGANIZATION, EMAIL_REPLY_TO_MISMATCH, EMAIL_LINK_DOMAIN_MISMATCH | medium |

The ML indicator uses code `ML_SCAM_LIKE_WORDING` and `source: "ml"`. Its `evidence` lists the normalised words that weighed most (e.g. `words that weighed most: your, verify, [link]`).
