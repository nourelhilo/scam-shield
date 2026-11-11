# Testing

```sh
npm test            # all tests (Vitest)
npm run typecheck   # tsc --noEmit
npm run lint        # ESLint
npm run check       # all three
npm run ml:test     # Python ML pipeline tests (needs `npm run ml:setup` once)
SCAMSHIELD_SLOW=1 npm run ml:test   # also retrains from prepared data and checks the model hash is identical
```

No production build is involved; the server runs TypeScript directly via `tsx`.

## What runs where

| Suite | Files | Uses |
|---|---|---|
| Unit | `tests/unit/*.test.ts` | Pure functions; **real trained model** for parity, predictions, explanations, and artifact integrity; hybrid decision table in isolation |
| Integration | `tests/integration/*.test.ts` | Real Fastify app through `app.inject()`; **real PostgreSQL engine via PGlite (in-memory)** |
| Security | `tests/security/*.test.ts` | Same harness as integration, with rate limiting enabled where tested |
| ML engine | `tests/integration/ml-worker.test.ts` | **Real worker threads** running the real model; fixture workers (`tests/fixtures/ml-workers/`) that hang, crash, or exhaust memory |
| ML pipeline (Python) | `ml/tests/*.py` | Loaders on fixture files in each source's real format, label mapping, validation, dedupe/conflicts, near-duplicate grouping, group-aware split, export → reference-model parity vs scikit-learn, deterministic serialisation, committed-artifact checks |

### Mocked vs real

| Dependency | In tests | Real-service verification |
|---|---|---|
| ML classifier | **Real model** (`ml/artifacts/scamshield-text-v1.0.0`), in-process by default and in worker threads in `ml-worker.test.ts`. `FakeEngine` doubles (`tests/helpers/ml.ts`) are used **only** to simulate timeouts, crashes, malformed output, or a fooled model, never for "successful ML" assertions. | Live server run (worker pool under `tsx`): three frontend examples gave High / Medium / High with real inference. |
| Email | **Mocked**: `MemoryMailer` | Console mailer used in a manual live run; SMTP **not verified** |
| OCR | **Mocked**: fake `OcrEngine` | **Manually verified once**: real Tesseract (English) read a generated screenshot through the live API at 91% confidence. Arabic OCR not run. |
| Database | PGlite (PostgreSQL in WebAssembly) | A standalone PostgreSQL server was **not available** on the development machine; the same SQL runs on `pg` in production. Run the suite's integration flows against real Postgres before launch. |

## Coverage map

- **Detection rules**: every text rule has positive and negative cases, including English and Arabic, and legitimate security warnings that must **not** match (`text-rules.test.ts`). Every URL rule has a triggering case plus false-positive guards for official URLs (`url-analyzer.test.ts`). Email parsing and each sender rule (`email-analyzer.test.ts`).
- **Risk classification**: thresholds, dampening, determinism, no percentages, wording guards (`risk-engine.test.ts`).
- **Normalisation**: invisible characters, Arabic letter unification, digits, language detection.
- **Input validation**: request schema, credentials, uploads (SVG/HTML/PDF/ELF/ZIP rejected), configuration fail-fast.
- **ML model**: Python↔TypeScript parity on 95 fixtures (normalisation identical, \|Δp\| < 1e-9); additive explanations (sum = decision); determinism; short, long, empty, misspelled, obfuscated, mixed-language input; truncation flag; latency budget; placeholder display.
- **Model artifact integrity**: checksum mismatch, invalid manifest, foreign or pickle-like formats, wrong normaliser version, array-length mismatch, all refused.
- **ML engine**: concurrency correctness (60 requests on 2 workers), bounded queue (`queue_full`), stuck-worker timeout + replacement, crash → `engine_error` + crash-loop cut-off, heap-limit kill, tampered model → `unavailable`, oversized input, metadata-only logging.
- **Hybrid decision**: full level table, never HIGH from ML alone, never lowers, one-step cap, UNKNOWN on model failure/unsupported language with no rule findings, URL path, ML indicator.
- **Analysis API**: the frontend's three examples, **checked with the exact acceptance logic from `checker.js`**; low/unknown handling; Arabic (model not applied, rules still work, benign → UNKNOWN); email subject + body; URL-only; OCR → ML; ML failure/timeout/invalid output/disabled fallbacks; saving; no content stored.
- **Auth**: register → verify → login, enumeration resistance, hashes at rest, logout, logout-all, reset, change password, profile, account deletion, expiry, resend verification.
- **Scan history**: filters, ordering, report download, cross-user isolation, delete one/all.
- **Feedback**: guest, owned scan, validation, not treated as ground truth.
- **Admin**: 401/403 matrix on every admin route, metrics without content, health, feedback review with audit, full article lifecycle with audit.
- **Database**: migrations idempotent, cascade/SET NULL behaviour, constraints, atomic single-use tokens, driver `rowCount` parity.
- **Security**: oversized and malformed payloads, content types, SQL-shaped input, malformed URLs, SSRF (fetch spy), auth header fuzzing, cross-user access, role escalation, prompt-injection-like content (real model and fooled-model double), explanation terms always from the submission, ML timeout, no LLM SDK in dependencies, upload types and sizes, headers, CORS, rate limits, static-file allow-list.

## Latest results

See `docs/BACKEND_PROGRESS.md` for the most recent recorded run.
