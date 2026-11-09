# Backend Progress

Last updated: 2026-11-09. Statuses are strict. **Tested** = automated tests pass. **Mocked** = external service replaced by a test double. **Unverified** = implemented but not exercised against the real external service.

Latest recorded run (2026-11-09, Node v24.14.0, macOS):

| Command | Result |
|---|---|
| `npm run typecheck` | pass (0 errors) |
| `npm run lint` | pass (0 problems) |
| `npm test` | **301 passed, 0 failed** (13 files: unit 203, integration 56, security 42) |
| Live server smoke test (curl against `npm start` equivalent, PGlite on disk) | health, analyze, frontend serving, register → email link → login, save, history, report, articles, CORS: all OK |
| Real OCR (Tesseract, English) via live API | OK (91% confidence on a generated screenshot) |
| Production build | **not run** (none exists; not requested) |

| Feature | Status | Evidence | Remaining Work |
|---|---|---|---|
| Repository inspection & architecture | Done | `docs/BACKEND_ARCHITECTURE.md` | — |
| Input validation | Implemented and tested | `tests/unit/validation.test.ts`, security tests | — |
| Rule-based text detection (EN + AR) | Implemented and tested | 18 rules + 2 obfuscation checks; positive/negative cases per rule | Expand Arabic phrase coverage; tune with real reviewed feedback |
| URL analysis (static, no fetching) | Implemented and tested | 21 rules; SSRF fetch-spy test | Optional reputation service (not integrated) |
| Email analysis (pasted, unverified) | Implemented and tested | 6 sender rules + text + link rules | SPF/DKIM/DMARC impossible without raw authenticated headers |
| Risk classification | Implemented and tested | `risk/risk-engine.ts`, thresholds documented | Calibrate thresholds on a labelled dataset |
| `POST /api/analyze` | Implemented and tested | Frontend-contract test replicates `checker.js` validation | — |
| AI provider abstraction + Anthropic provider | Implemented, tested with mocks; **real API unverified** | `tests/unit/ai.test.ts` (fake HTTP through the official SDK) | Run with a real `ANTHROPIC_API_KEY`; measure latency vs the 12 s budget |
| AI fallback / prompt-injection controls | Implemented and tested | Compromised-model test, timeout test | — |
| Database schema & migrations | Implemented and tested on PGlite; **real PostgreSQL server unverified** | `tests/integration/database.test.ts` | Run `npm run db:migrate` + test flows against a real Postgres |
| Authentication (register, verify, login, logout, reset, change password, sessions) | Implemented and tested (mail mocked) | `tests/integration/auth.test.ts` | Real SMTP delivery unverified |
| User profile & account deletion | Implemented and tested | auth tests | — |
| Scan history (opt-in) + reports | Implemented and tested | `scans-feedback.test.ts` | PDF reports not implemented (txt/json only) |
| Feedback API | Implemented and tested | `scans-feedback.test.ts` | — |
| Admin API (RBAC, metrics, feedback review, health, audit) | Implemented and tested | `admin-articles.test.ts` | Admin UI is frontend work |
| Educational content API + seed | Implemented and tested | 7 seeded articles | More Arabic content |
| Screenshot OCR | Implemented; tested with fake engine; real Tesseract manually verified (English) | security tests; live run | Arabic OCR accuracy not verified; disabled by default |
| Multilingual analysis (Arabic) | Partially implemented | Arabic normalisation + Arabic patterns in all major rules; tested | Responses (explanations/recommendations) are English only |
| Rate limiting | Implemented and tested (in-memory, per process) | security tests | Shared store needed for multi-instance deployment |
| Security headers / CORS / log redaction | Implemented and tested | security tests | — |
| Frontend integration guide | Done | `FRONTEND_INTEGRATION.md` | Frontend work by teammate |
| Deployment | **Not done** (not requested) | — | Hosting, managed Postgres, SMTP, secrets |
| Data-retention purge job | Not implemented | — | Scheduled purge of old feedback/audit/stats |
