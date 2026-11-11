# ScamShield — Frontend Integration Guide

This guide is for the frontend owner. It explains how to connect the existing website to the backend **without changing the design**. Nothing here asks you to change colours, typography, layout, or components. Where new UI is needed (for example a sign-in form), you decide how it looks.

> **Good news first:** the current `checker.js` already works with the backend as-is. The response includes the exact fields it reads (`risk`, `summary`, `warnings`, `recommendations`). The only change needed to go live is setting one attribute (see [C.1](#c1-text--url--email-analyzer-already-built)).

---

## A. Backend overview

The backend is a TypeScript (Node.js + Fastify) API in `server/`. It:

1. **Analyses** text messages, links, and pasted emails with a rule-based detection engine (English and Arabic) **and ScamShield's own machine-learning classifier** (English), which runs inside the backend. No external AI service is used and no API key is needed.
2. **Classifies** risk as `low`, `medium`, `high`, or `unknown`, with evidence for every warning sign. `low` never means "safe".
3. **Accounts (optional for users):** register, verify email, sign in, opt-in scan history, feedback, and account deletion.
4. **Educational articles** and an **admin API**.

How it connects to the frontend:

```
Browser (index.html + checker.js)
   │  fetch("POST /api/analyze", JSON)
   ▼
ScamShield API (server/)  ──►  PostgreSQL (or embedded PGlite in development)
                          ──►  ML classifier (local worker threads; no external calls)
```

During development the API can also **serve the frontend files itself** (`SERVE_FRONTEND=true`, the default). Then the page and API share one origin and no CORS setup is needed:

```sh
npm install
npm run dev            # http://127.0.0.1:3000  (page + API)
```

When the API serves `index.html` and the attribute `data-analysis-endpoint=""` is empty, the *served copy* points it at `/api/analyze`. **Your file on disk is never modified.**

---

## B. Available APIs

Base URL: same origin as the page (`/api/...`) or your configured API origin.
All requests and responses are JSON unless noted. All errors use one shape:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "The request is invalid.", "details": [{ "path": "content", "message": "Content is required." }] } }
```

`message` is always safe to show to users. `details` is only present for some errors.

Authentication: send `Authorization: Bearer <token>` (the token comes from `POST /api/auth/login`). There are no cookies, so `credentials: "omit"` (what `checker.js` uses) is correct.

| Method | URL | Purpose | Auth | Status |
|---|---|---|---|---|
| GET | `/api/health` | Liveness + which features are on | none | Implemented and tested |
| POST | `/api/analyze` | Analyse text / URL / email | optional (required only for `save: true`) | Implemented and tested |
| POST | `/api/analyze/image` | OCR a screenshot, then analyse it | optional | Implemented and tested (mocked OCR); real OCR manually verified for English only |
| POST | `/api/auth/register` | Create an account | none | Implemented and tested |
| GET | `/api/auth/verify-email?token=` | Link target in the verification email (plain text) | none | Implemented and tested |
| POST | `/api/auth/verify-email` | Verify with a token (JSON) | none | Implemented and tested |
| POST | `/api/auth/resend-verification` | Send a new verification email | none | Implemented and tested (mocked mail) |
| POST | `/api/auth/login` | Sign in, get a bearer token | none | Implemented and tested |
| POST | `/api/auth/logout` | End this session | required | Implemented and tested |
| POST | `/api/auth/logout-all` | End all sessions | required | Implemented and tested |
| POST | `/api/auth/password-reset/request` | Email a reset token | none | Implemented and tested (mocked mail) |
| POST | `/api/auth/password-reset/confirm` | Set a new password with the token | none | Implemented and tested |
| POST | `/api/auth/change-password` | Change password while signed in | required | Implemented and tested |
| GET | `/api/me` | Current user profile | required | Implemented and tested |
| PATCH | `/api/me` | Update display name | required | Implemented and tested |
| DELETE | `/api/me` | Delete account and all data | required | Implemented and tested |
| GET | `/api/scans` | List saved scans (filters) | required | Implemented and tested |
| GET | `/api/scans/:id` | One saved scan | required | Implemented and tested |
| GET | `/api/scans/:id/report?format=txt\|json` | Download a report | required | Implemented and tested |
| DELETE | `/api/scans/:id` | Delete one saved scan | required | Implemented and tested |
| DELETE | `/api/scans` | Delete all saved scans | required | Implemented and tested |
| POST | `/api/feedback` | Report a wrong or unclear result | optional | Implemented and tested |
| GET | `/api/articles` | List published articles | none | Implemented and tested |
| GET | `/api/articles/:slugOrId` | One published article | none | Implemented and tested |
| GET/POST/PATCH/DELETE | `/api/admin/...` | Admin (see below) | admin role | Implemented and tested |

Full request/response field reference: [`docs/API_DOCUMENTATION.md`](docs/API_DOCUMENTATION.md). The essentials follow.

### B.1 `POST /api/analyze`

**Request**

```json
{ "type": "text", "content": "Your delivery is on hold. Pay a redelivery fee in the next 30 minutes at https://parcel-alert.example/release." }
```

| Field | Type | Notes |
|---|---|---|
| `type` | `"text"` \| `"url"` \| `"email"` | required |
| `content` | string, ≤ 10,000 chars | required (for `email` you may use `email` instead) |
| `email` | `{ from?, replyTo?, subject?, body? }` | optional, only for `type: "email"` |
| `save` | boolean, default `false` | `true` saves to history; requires sign-in |

For `email`, pasting `"Subject: ...\n\nbody"` (what the current UI does) works. `From:` and `Reply-To:` lines at the top are also understood.

**Response (200)** — trimmed real output:

```json
{
  "analysisId": "8d3c…",
  "status": "completed",
  "inputType": "text",
  "riskLevel": "high",
  "risk": "high",
  "summary": "This message shows several strong warning signs that are common in scams, including pressure to act quickly, unusual payment demands and a parcel-delivery problem. Treat it as likely fraudulent …",
  "explanation": "(same as summary)",
  "warnings": ["The message pressures you to act quickly. (“in the next 30 minutes”)", "…"],
  "indicators": [
    { "code": "URGENT_LANGUAGE", "category": "pressure", "severity": "medium", "description": "The message pressures you to act quickly.", "evidence": "in the next 30 minutes", "source": "rules" }
  ],
  "recommendations": ["Do not send money, gift cards, or cryptocurrency. These payments are very hard to reverse.", "…"],
  "ruleIndicators": [ "…the rule/URL/email indicators only…" ],
  "analysisMethod": "rules+ml",
  "modelVersion": "scamshield-text-v1.0.0",
  "mlPrediction": { "status": "used", "reason": null, "modelVersion": "scamshield-text-v1.0.0", "probability": 0.9677, "band": "strong", "label": "suspicious", "decisionThreshold": 0.5, "truncated": false, "latencyMs": 1.07, "interpretation": "The model scored this text 0.9677 … This is a statistical score, not a calibrated probability that the message is a scam." },
  "modelExplanation": { "method": "linear_term_contributions", "towardSuspicious": [{ "term": "fee", "display": "fee", "weight": 1.2 }, "…"], "towardLegitimate": ["…"], "note": "These are the words … not proof that the message is fraudulent. …" },
  "hybrid": { "ruleRiskLevel": "high", "adjustment": "none", "agreement": "agree", "reasons": ["…"], "mlOnlyCanRaise": true },
  "ai": { "status": "not_configured", "provider": null, "model": null, "summary": null, "reason": "external_ai_removed" },
  "language": "en",
  "disclaimer": "ScamShield gives an automated risk estimate …",
  "saved": false,
  "scanId": null,
  "createdAt": "2026-11-09T17:38:31.025Z"
}
```

- `risk`, `summary`, `warnings`, and `recommendations` are what `checker.js` already uses.
- `riskLevel`, `explanation`, and `indicators` are the richer versions if you want them later.
- For `type: "email"` the response also has `email: { senderVerified: false, fromAddress, note }`. Pasted senders can't be verified, so show `note` if you display sender details.
- `analysisMethod` is `"rules"` or `"rules+ml"` (rules plus ScamShield's own model). Older saved scans may show `"rules+ai"`.
- `mlPrediction.status` is `used`, `not_applicable` (links, Arabic/mixed text, too little text), `unavailable`, or `failed`. When it isn't `used`, `probability` is `null`. **Never show `probability` as "% chance of scam"**: it is a resemblance score (see `interpretation`).
- `ai` is **deprecated** (external AI was removed) and always reports `not_configured`.
- `warnings` may contain one extra line from the model ("…statistical resemblance, not proof"), and `indicators` may contain an entry with `source: "ml"`.

**Errors:** `400 VALIDATION_ERROR` (empty, too long, bad type, unparseable URL), `401 UNAUTHORIZED` (`save: true` without sign-in), `413 PAYLOAD_TOO_LARGE`, `415 UNSUPPORTED_MEDIA_TYPE`, `429 RATE_LIMITED` (20 per minute per IP), `500 INTERNAL_ERROR`.

### B.2 `POST /api/analyze/image`

`multipart/form-data` with one field named `file` (PNG, JPEG, or WebP, ≤ 5 MB; the file's bytes are checked, not its name). Optional text field `save` = `"true"`.
The response is the same as B.1, with `inputType: "image"` plus:

```json
"ocr": { "engine": "tesseract", "characters": 80, "confidence": 91, "extractedText": "Your parcel is on hold…", "truncated": false }
```

Show `extractedText` so the user can check what was read.
**Errors:** `400` (no or empty file), `413 FILE_TOO_LARGE`, `415 UNSUPPORTED_FILE_TYPE`, `503 OCR_DISABLED` (default; the server needs `OCR_ENABLED=true`), `503 OCR_BUSY`, `504 OCR_TIMEOUT`, `422 OCR_FAILED`, `429` (6 per minute).

```js
const form = new FormData();
form.append("file", fileInput.files[0]);
const res = await fetch("/api/analyze/image", { method: "POST", body: form }); // do NOT set Content-Type yourself
```

### B.3 Auth

| Endpoint | Body | Success |
|---|---|---|
| `POST /api/auth/register` | `{ email, password, displayName? }` (password 10–128 chars) | `202 { status: "accepted", message }`. **Same response even if the email already exists** (privacy). |
| `POST /api/auth/login` | `{ email, password }` | `200 { token, tokenType: "Bearer", expiresAt, user }` |
| `POST /api/auth/logout` | — | `204` |
| `POST /api/auth/verify-email` | `{ token }` | `200 { status: "verified" }` |
| `POST /api/auth/resend-verification` | `{ email }` | `202` (always) |
| `POST /api/auth/password-reset/request` | `{ email }` | `202` (always) |
| `POST /api/auth/password-reset/confirm` | `{ token, newPassword }` | `200`; all sessions are signed out |
| `POST /api/auth/change-password` | `{ currentPassword, newPassword }` | `200`; other sessions are signed out |

`user` = `{ id, email, displayName, role: "user"|"admin", emailVerified, createdAt }`.

Auth errors: `401 INVALID_CREDENTIALS` (a deliberately generic message), `403 EMAIL_NOT_VERIFIED`, `400 INVALID_TOKEN` (expired or used link), `429` (10 attempts per 15 minutes on login and register).

The verification email links straight to the backend (`/api/auth/verify-email?token=…`), which answers with a plain-text confirmation, so **no frontend page is needed for verification**. The password-reset email links to `PUBLIC_APP_URL/reset-password?token=…`, so **a reset page is needed** (see G).

### B.4 Profile — `GET /api/me`, `PATCH /api/me` `{ displayName }`, `DELETE /api/me` `{ password }`

`DELETE` permanently removes the account, its saved scans, sessions, and feedback, and returns `204`. Ask the user to confirm first.

### B.5 Scan history (signed-in only)

- `GET /api/scans?riskLevel=high&from=2026-11-01&to=2026-11-30&limit=20&offset=0` → `{ items: Scan[], total, limit, offset }`, newest first.
- `GET /api/scans/:id` → `{ scan }`
- `GET /api/scans/:id/report?format=txt` (or `json`) → a file download (`Content-Disposition: attachment`).
- `DELETE /api/scans/:id` → `204`; `DELETE /api/scans` → `{ deleted: n }`.

`Scan` = `{ scanId, inputType, contentLength, language, riskLevel, indicators (no evidence), explanation, recommendations, analysisMethod, aiStatus (deprecated), mlStatus, modelVersion, createdAt }`.
**The original message is never stored**, so history can't show it. Show the risk, the explanation, and the date.
Another user's scan id returns `404`.

### B.6 Feedback — `POST /api/feedback`

```json
{ "feedbackType": "false_positive", "analysisId": "<from the analyze response>", "reportedRiskLevel": "low", "comment": "This is my real bank" }
```

`feedbackType`: `false_positive` | `missed_scam` | `unclear_explanation` | `other`. Use `analysisId` (works for guests) or `scanId` (signed-in, must be your own). `comment` ≤ 1,000 chars and optional; tell users not to include personal details. Success: `201 { feedbackId, status: "received" }`. Limit: 10 per hour per IP.

### B.7 Articles

- `GET /api/articles?category=sms_scams&language=en&limit=20&offset=0` → `{ items, total, limit, offset, categories }` (list items have no `body`)
- `GET /api/articles/spotting-phishing-messages` → `{ article: { id, slug, title, category, language, summary, body, status, publishedAt, updatedAt } }`

Categories: `phishing`, `fake_shopping`, `sms_scams`, `email_fraud`, `account_impersonation`, `payment_safety`. Seven starter articles ship with the backend (six English, one Arabic).
**Render `body` as text** (e.g. `textContent`, splitting paragraphs on blank lines), never as HTML.

### B.8 Admin (role `admin` only; `401` for guests, `403` for regular users)

| Endpoint | Purpose |
|---|---|
| `GET /api/admin/metrics?days=30` | Aggregate counts by risk, type, and method; users; saved scans; feedback |
| `GET /api/admin/health` | Database, ML model, OCR, mail, and rate-limit status |
| `GET /api/admin/rules` | Detection rule catalogue |
| `GET /api/admin/feedback?status=open&type=…` / `PATCH /api/admin/feedback/:id` `{ status }` | Review feedback |
| `GET /api/admin/articles`, `GET /api/admin/articles/:id` | Includes drafts |
| `POST /api/admin/articles` | `{ slug, title, category, language, summary, body, status? }` |
| `PATCH /api/admin/articles/:id` | Any subset of the fields above |
| `POST /api/admin/articles/:id/publish` / `unpublish` | |
| `DELETE /api/admin/articles/:id` | |
| `GET /api/admin/audit-logs` | Who did what |

Admins are created from the terminal: `npm run admin:promote -- someone@example.com`.

---

## C. How to connect the frontend

### C.1 Text / URL / email analyzer (already built)

**Option 1 — API serves the page (simplest):** run `npm run dev` and open `http://127.0.0.1:3000`. Nothing to change.

**Option 2 — separate static server** (`python -m http.server 4173`): set the attribute in `index.html`:

```html
<form id="scan-form" data-analysis-endpoint="http://127.0.0.1:3000/api/analyze" novalidate>
```

`http://127.0.0.1:4173` and `http://localhost:4173` are allowed by CORS in development. For production, use a same-origin path such as `/api/analyze`.

That's the only change needed for the current UI. Acceptance: pasting each "Try an example" sample and pressing **Analyze for scam** shows a risk label, a summary, warning signs, and next steps. (An automated test replicates `checker.js`'s `renderResult` checks against real responses.)

### C.2 Analysis results (optional enhancements)

- `indicators[].severity` lets you visually rank warning signs, styled however you choose.
- Show `disclaimer` near the result. Your existing note already says something similar.
- Show `email.note` for email results.
- Optional: show `modelExplanation.towardSuspicious[].display` as "words that raised the score", with `modelExplanation.note` as the caption. Present it as secondary detail, never in place of `summary`.
- Optional: show the model limitations from `FRIEND_HANDOFF.md` section 9 near results.

### C.3 Authentication

Store the token in memory (or `sessionStorage` if you need it to survive reloads; avoid `localStorage`). Send it as a header:

```js
const res = await fetch("/api/me", { headers: { Authorization: `Bearer ${token}` } });
if (res.status === 401) { /* token expired: clear it and show sign-in */ }
```

### C.4 Scan history

Add a "Save to my history" checkbox, visible only when signed in, that sends `save: true` with the analyze request. Then build a history list from `GET /api/scans` with filters for risk and date. Delete buttons should call `DELETE /api/scans/:id`, or `DELETE /api/scans` after a confirmation.

### C.5 Feedback

After a result, add a small "Was this wrong?" control that posts `{ feedbackType, analysisId }`.

### C.6 Educational content

Build a list from `GET /api/articles` and a detail view from `GET /api/articles/:slug`.

### C.7 Admin

This is optional. A simple page for admins only that uses the `/api/admin/*` endpoints. The server enforces the role regardless of what the UI hides.

---

## D. Environment configuration (frontend-safe)

The frontend needs **only the API location**:

- Same origin: `/api/analyze` (nothing to configure).
- Separate origin: the API base URL, e.g. `http://127.0.0.1:3000`, which must be listed in the server's `CORS_ORIGINS`.

**Never** put `DATABASE_URL`, `SMTP_URL`, or any other `.env` value in frontend code. The frontend needs no ML configuration: the model runs inside the API.

---

## E. Error handling

| Situation | How to detect | Suggested message (wording is yours) |
|---|---|---|
| Validation error | `400`, `error.code === "VALIDATION_ERROR"` | Show `error.message`; highlight the field from `error.details[].path` |
| Rate limited | `429` (`error.details.retryAfterSeconds`, `Retry-After` header) | `checker.js` already handles 429 |
| Not signed in or expired | `401` | Clear the token and show sign-in |
| Forbidden | `403` (`EMAIL_NOT_VERIFIED` or admin-only) | "Verify your email first" / hide admin UI |
| Too large | `413` | "Shorten your entry" / "Use a smaller image" |
| Backend failure | `5xx`, network error, timeout | `checker.js` already shows a generic retry message |
| ML model unavailable or slow | **Not an error.** Response is `200` with `mlPrediction.status: "failed"` or `"unavailable"` and `analysisMethod: "rules"` | Optional: "Showing rule-based result" |
| Unknown result | `200` with `risk: "unknown"` | The UI already has an "Unknown risk" label; show `summary` |

The model's timeout (1.5 s) is far below the frontend's 15 s timeout; typical inference takes about 1 ms.

---

## F. Implementation status

See the table in [B](#b-available-apis). In short: every endpoint listed is implemented and covered by automated tests. Tests use the real trained model; doubles are used for email, OCR, and simulated model failures. Not verified: real SMTP delivery, Arabic OCR, and a real PostgreSQL server (tests use PGlite, which is real PostgreSQL compiled to WebAssembly). Nothing is deployed.

---

## G. What to do next (prioritised)

1. **Connect the analyzer** (5 min). Option 1 or 2 in C.1.
   *Accept when:* all three "Try an example" samples show a result; an empty submission shows the existing validation message; 20+ rapid submissions show the existing 429 message.
2. **Show richer results (optional).** Depends on `indicators`, `disclaimer`, `email.note`.
   *Accept when:* email results show that the sender is unverified.
3. **Sign-in / register forms.** Depends on `/api/auth/register`, `/login`, `/logout`, `/api/me`.
   *Accept when:* a new user can register, click the emailed link (in development it is printed in the API terminal), sign in, see their email, and sign out; a wrong password shows the generic message.
4. **Password reset page** at `/reset-password?token=…`. Depends on `/api/auth/password-reset/request` and `/confirm`.
   *Accept when:* the reset link from the email opens the page, a new password is accepted, and the old one no longer works.
5. **Scan history.** Depends on `save: true`, `/api/scans*`.
   *Accept when:* saved scans appear newest first, filters work, the report downloads, and deleting removes them.
6. **Feedback control.** Depends on `/api/feedback`. *Accept when:* submitting shows a thank-you and returns `201`.
7. **Articles section.** Depends on `/api/articles*`. *Accept when:* the seven starter articles list, filter by category, and open, with the body rendered as text.
8. **Screenshot upload (optional).** Depends on `/api/analyze/image` (server needs `OCR_ENABLED=true`). *Accept when:* a screenshot of a scam SMS returns a result and shows the extracted text.
9. **Account settings.** Display name, change password, delete account (with confirmation).
10. **Admin page (optional).**
