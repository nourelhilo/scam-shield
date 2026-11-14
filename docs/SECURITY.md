# Security and Privacy

Each control is listed with where it lives and how it is verified. "Tested" means an automated test in `tests/` exercises it.

## Controls

| Area | Implementation | Verified |
|---|---|---|
| Input validation | Zod schemas on every body/query/param; unknown fields rejected; content ≤ 10,000 chars | Tested (`tests/unit/validation.test.ts`, security tests) |
| Request size limits | JSON body 64 KB; upload ≤ 5 MB (`UPLOAD_MAX_BYTES`), 1 file, limited fields/parts | Tested (413 cases) |
| Rate limiting | `@fastify/rate-limit`, per IP, per route (see `server/lib/limits.ts`) | Tested (analyze, login) |
| Authentication | Opaque 256-bit bearer tokens; only SHA-256 stored; server-side expiry and revocation | Tested |
| Passwords | Argon2id (m=19 MiB, t=2, p=1); 10–128 chars; constant-work login for unknown users | Tested (hash format, generic errors) |
| Account enumeration | Register, resend, and reset-request return identical responses; generic login error | Tested |
| Authorization | Every user resource filtered by `user_id` in SQL; foreign IDs → 404; admin role checked from DB per request | Tested (cross-user, role escalation, 401/403 matrix) |
| Session handling | Logout, logout-all, password change/reset revoke sessions; expired sessions rejected | Tested |
| Safe errors | Central error handler; 5xx return a generic message; stack traces only in server logs; inputs not echoed | Tested |
| Injection | Parameterised SQL only; enum/uuid validation before queries | Tested (SQL-shaped input) |
| Safe URL handling / SSRF | URLs are **parsed, never fetched**. No user-controlled outbound requests exist anywhere | Tested (fetch spy asserts zero calls) |
| No external AI | No LLM/AI SDK in dependencies and no `server/ai/`; submitted content is never sent to an AI provider; inference is local | Tested (dependency guard; fetch spy asserts zero outbound calls during analysis) |
| Prompt-injection-like content | The classifier is a statistical model with no instructions to follow; injected text is just features. The `PROMPT_INJECTION_ATTEMPT` rule still flags it; ML can never lower a rule finding; explanation is deterministic | Tested with the real model and with a deliberately "fooled" model double |
| Model artifact integrity | Model is plain JSON (no pickle/joblib); SHA-256 must match `manifest.json`; strict schema (formats, versions, array lengths, band order); loaded only from a local directory (`ML_MODEL_DIR`, default the committed artifact); refusal → rules-only with `mlPrediction.status: "unavailable"` | Tested (tampered file, bad manifest, foreign formats, length mismatch) |
| Inference isolation | Worker threads with a V8 heap limit, per-request timeout (stuck worker terminated), bounded queue, crash-loop cut-off; worker stdout/stderr discarded; errors carry no content | Tested (hang, crash, out-of-memory, queue-full fixtures) |
| File handling | Magic-byte sniffing (PNG/JPEG/WebP only; SVG/HTML/PDF/executables rejected); in-memory processing (no temp files); OCR queue + timeout; nothing executed | Tested (fake OCR); real Tesseract verified manually (English) |
| Secrets | Server-only env vars; config errors never print values; `.env` git-ignored; the frontend never receives keys | Reviewed; config test |
| Security headers | Helmet: CSP (`default-src 'self'`, no inline scripts/styles, `frame-ancestors 'none'`), nosniff, referrer policy, HSTS in production | Tested |
| Log redaction | Authorization/cookie headers redacted; request bodies never logged; query strings stripped from logged URLs; ML logs contain status, reason, band, latency, and model version only; ignored legacy AI settings are logged by **name** only | Tested (ML log events contain no content); live run inspected (no content, tokens, or keys in logs) |
| CORS | Explicit origin allow-list (`CORS_ORIGINS`); no credentials; production default is none | Tested |
| Static files | Frontend routes use an explicit allow-list. The password-reset page uses `Cache-Control: no-store` and `Referrer-Policy: no-referrer`. | Tested |
| Abuse prevention | Rate limits; per-user feedback cap; OCR queue cap; ML queue cap; ML input cap (skips, never silently truncates) | Tested |

## Rate limiting: deployment caveat

The limiter uses the plugin's **in-memory store, per process**. This is real protection for a single instance, but it is **not distributed**: each instance counts separately and counts reset on restart. For multiple instances or serverless deployments, configure a shared store (e.g. Redis via `@fastify/rate-limit`'s `redis` option) or a platform/WAF rate limit. Behind a reverse proxy, set `TRUST_PROXY=true` (only for a proxy you control) so limits apply to the real client IP rather than the proxy's.

## Email authenticity

Pasted email senders are **unverified**. The backend does not check SPF, DKIM, or DMARC, because it never receives authenticated original headers. Responses say so (`email.senderVerified: false`).

## Privacy

- No raw submissions are stored (see `docs/DATABASE_SCHEMA.md`).
- Saved history is opt-in per request (`save: true`) and requires an account.
- Account deletion removes all user data.
- Admin analytics are aggregate counts.
- Submitted content is analysed locally and is **not** sent to any AI provider.
- The ML model was trained only on public datasets with documented provenance (`docs/DATASET_SOURCES.md`). **User submissions are never used for training** (they are not stored, and no consent mechanism for training exists).
- **Not fully offline:** OCR (if enabled) downloads Tesseract language data from its CDN on first use, and email uses the configured SMTP server. Retraining downloads datasets from their publishers. Normal scam analysis makes no outbound requests, and the app has no telemetry.

## Known residual risks

1. In-memory rate limiting (above).
2. Bearer tokens kept by the frontend are exposed to any XSS in the frontend; CSP blocks inline script to reduce this risk. Keep tokens out of `localStorage`.
3. Tesseract downloads language data from its CDN on first use (fixed vendor destination). For locked-down environments, pre-place the `traineddata` files in `OCR_CACHE_DIR`.
4. CI audits production dependencies. Run `npm audit` locally to include dev tooling.
5. No automated data-retention purge yet.
6. No account lockout beyond IP rate limiting (a distributed attacker could attempt password guessing slowly).
7. The ML model can be evaded by unusual wording or heavy character obfuscation, and over-flags some legitimate notifications (`docs/MODEL_LIMITATIONS.md`). It is one signal, not a security boundary.
