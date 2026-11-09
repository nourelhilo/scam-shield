# Testing

```sh
npm test            # all tests (Vitest)
npm run typecheck   # tsc --noEmit
npm run lint        # ESLint
npm run check       # all three
```

No production build is involved; the server runs TypeScript directly via `tsx`.

## What runs where

| Suite | Files | Uses |
|---|---|---|
| Unit | `tests/unit/*.test.ts` | Pure functions; AI provider via `StaticAiProvider` and a fake `fetch` for the Anthropic SDK |
| Integration | `tests/integration/*.test.ts` | Real Fastify app through `app.inject()`; **real PostgreSQL engine via PGlite (in-memory)** |
| Security | `tests/security/*.test.ts` | Same harness as integration, with rate limiting enabled where tested |

### Mocked vs real

| Dependency | In tests | Real-service verification |
|---|---|---|
| AI provider (Anthropic) | **Mocked**: `StaticAiProvider` and a fake HTTP layer injected into the official SDK | **Not run**: no API key was available. Request shape, error mapping, and validation are tested against the SDK with fake responses. |
| Email | **Mocked**: `MemoryMailer` | Console mailer used in a manual live run; SMTP **not verified** |
| OCR | **Mocked**: fake `OcrEngine` | **Manually verified once**: real Tesseract (English) read a generated screenshot through the live API at 91% confidence. Arabic OCR not run. |
| Database | PGlite (PostgreSQL in WebAssembly) | A standalone PostgreSQL server was **not available** on the development machine; the same SQL runs on `pg` in production. Run the suite's integration flows against real Postgres before launch. |

## Coverage map

- **Detection rules**: every text rule has positive and negative cases, including English and Arabic, and legitimate security warnings that must **not** match (`text-rules.test.ts`). Every URL rule has a triggering case plus false-positive guards for official URLs (`url-analyzer.test.ts`). Email parsing and each sender rule (`email-analyzer.test.ts`).
- **Risk classification**: thresholds, dampening, determinism, no percentages, wording guards (`risk-engine.test.ts`).
- **Normalisation**: invisible characters, Arabic letter unification, digits, language detection.
- **Input validation**: request schema, credentials, uploads (SVG/HTML/PDF/ELF/ZIP rejected), configuration fail-fast.
- **AI response validation**: schema rejection, evidence check, timeout, retries, skip on oversized input, prompt delimiting, refusal/429/401/garbage mapping.
- **Analysis API**: the frontend's three examples, **checked with the exact acceptance logic from `checker.js`**; low/unknown handling; Arabic; saving; no content stored; AI used/failed.
- **Auth**: register → verify → login, enumeration resistance, hashes at rest, logout, logout-all, reset, change password, profile, account deletion, expiry, resend verification.
- **Scan history**: filters, ordering, report download, cross-user isolation, delete one/all.
- **Feedback**: guest, owned scan, validation, not treated as ground truth.
- **Admin**: 401/403 matrix on every admin route, metrics without content, health, feedback review with audit, full article lifecycle with audit.
- **Database**: migrations idempotent, cascade/SET NULL behaviour, constraints, atomic single-use tokens, driver `rowCount` parity.
- **Security**: oversized and malformed payloads, content types, SQL-shaped input, malformed URLs, SSRF (fetch spy), auth header fuzzing, cross-user access, role escalation, prompt injection with a compromised model, AI timeout, upload types and sizes, headers, CORS, rate limits, static-file allow-list.

## Latest results

See `docs/BACKEND_PROGRESS.md` for the most recent recorded run.
