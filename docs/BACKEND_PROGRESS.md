# Backend Progress

Last updated: 2026-11-14. Statuses are strict. **Tested** = automated tests pass. **Mocked** = external service replaced by a test double. **Unverified** = implemented but not exercised against the real external service.

Latest recorded run (2026-11-14, Node v24.14.0, macOS): `npm run typecheck` pass, `npm run lint` pass, `npm test` **457 passed, 0 failed** (15 files; +2 configuration-validation tests). ML pipeline, live smoke test, and OCR were not re-run.

Previous full run (2026-11-11, Node v24.14.0, Python 3.14.3, macOS):

| Command | Result |
|---|---|
| `npm run typecheck` | pass (0 errors) |
| `npm run lint` | pass (0 problems) |
| `npm test` | **455 passed, 0 failed** (15 files: unit 337, integration 74, security 44), using the real model |
| `npm run ml:test` | 25 passed, 1 skipped (slow); `SCAMSHIELD_SLOW=1` run: 4/4 passed, retraining reproduced the identical model SHA-256 |
| `npm run ml:pipeline` | download verified (17 files), 14,728 records prepared, model trained and exported, hybrid evaluated |
| Live server smoke test (`tsx server/index.ts`, worker engine, PGlite on disk) | `ml: true`; frontend examples High / Medium / High; legacy `ANTHROPIC_API_KEY` ignored with a warning (name only); no submitted text in logs |
| Real OCR (Tesseract, English) via live API | OK on 2026-11-09 (not re-run) |
| Production build | **not run** (none exists; not requested) |

| Feature | Status | Evidence | Remaining Work |
|---|---|---|---|
| Repository inspection & architecture | Done | `docs/BACKEND_ARCHITECTURE.md` | — |
| Input validation | Implemented and tested | `tests/unit/validation.test.ts`, security tests | — |
| Configuration validation | Implemented and tested | `server/config.ts`; production requires `DATABASE_URL`, `MAIL_TRANSPORT=smtp` + `SMTP_URL`, explicit `https://` `PUBLIC_APP_URL`; URL formats checked without echoing values | — |
| Rule-based text detection (EN + AR) | Implemented and tested | 18 rules + 2 obfuscation checks; positive/negative cases per rule | Expand Arabic phrase coverage; tune with real reviewed feedback |
| URL analysis (static, no fetching) | Implemented and tested | 21 rules; SSRF fetch-spy test | Optional reputation service (not integrated) |
| Email analysis (pasted, unverified) | Implemented and tested | 6 sender rules + text + link rules | SPF/DKIM/DMARC impossible without raw authenticated headers |
| Risk classification (rules) | Implemented and tested | `risk/risk-engine.ts`, thresholds documented | — |
| **Custom ML classifier** (`scamshield-text-v1.0.0`) | Implemented and verified | Trained on 4 public datasets; test F1 0.970 / FPR 0.66% (in-distribution); parity and integrity tests; `docs/MODEL_EVALUATION.md` | English only; licensed real Arabic data and modern legitimate-notification data needed; calibration |
| ML inference engine (worker pool) | Implemented and verified | `tests/integration/ml-worker.test.ts`; live server | Multi-instance deployment sizing |
| Hybrid rules + ML decision | Implemented and verified | `tests/unit/hybrid.test.ts`; policy chosen on validation (`hybrid_metrics.json`) | Reduce MEDIUM false positives on legitimate notifications |
| External AI (Anthropic) | **Removed** | `server/ai/` and `@anthropic-ai/sdk` deleted; dependency guard test | — |
| `POST /api/analyze` | Implemented and tested | Frontend-contract test replicates `checker.js` validation | — |
| ML fallback / prompt-injection-like content | Implemented and tested | Fooled-model, timeout, crash, invalid-output, disabled tests | — |
| Database schema & migrations | Implemented and tested on PGlite; **real PostgreSQL server unverified** | `tests/integration/database.test.ts` | Run `npm run db:migrate` + test flows against a real Postgres |
| Authentication (register, verify, login, logout, reset, change password, sessions) | Implemented and tested (mail mocked) | `tests/integration/auth.test.ts` | Real SMTP delivery unverified |
| User profile & account deletion | Implemented and tested | auth tests | — |
| Scan history (opt-in) + reports | Implemented and tested | `scans-feedback.test.ts` | PDF reports not implemented (txt/json only) |
| Feedback API | Implemented and tested | `scans-feedback.test.ts` | — |
| Admin API (RBAC, metrics, feedback review, health, audit) | Implemented and tested | `admin-articles.test.ts` | Admin UI is frontend work |
| Educational content API + seed | Implemented and tested | 7 seeded articles | More Arabic content |
| Screenshot OCR | Implemented; tested with fake engine; real Tesseract manually verified (English) | security tests; live run | Arabic OCR accuracy not verified; disabled by default |
| Multilingual analysis (Arabic) | Partially implemented | Arabic normalisation + Arabic patterns in all major rules; tested. **ML model: blocked**, because no openly licensed real Arabic data exists | Explanations English only; Arabic ML needs licensed data |
| Rate limiting | Implemented and tested (in-memory, per process) | security tests | Shared store needed for multi-instance deployment |
| Security headers / CORS / log redaction | Implemented and tested | security tests | — |
| Frontend integration guide | Done | `FRONTEND_INTEGRATION.md` | Frontend work by teammate |
| Deployment | **Not done** (not requested) | — | Hosting, managed Postgres, SMTP, secrets |
| Data-retention purge job | Not implemented | — | Scheduled purge of old feedback/audit/stats |
