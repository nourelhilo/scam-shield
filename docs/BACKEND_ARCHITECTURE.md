# Backend Architecture

## Stack

| Concern | Choice | Why |
|---|---|---|
| Language/runtime | TypeScript on Node.js ≥ 22.12 (run with `tsx`, no build step) | Type safety; matches the JS frontend |
| HTTP | Fastify 5 | Built-in body limits, fast `inject()` testing, mature plugins |
| Validation | Zod 4 | One schema per request; user-safe error details |
| Database | PostgreSQL via `pg`; **PGlite** (PostgreSQL in WebAssembly) for dev/tests | Real Postgres semantics without installing a server |
| Passwords | Argon2id (`@node-rs/argon2`) | OWASP-recommended |
| ML classifier | ScamShield's own logistic-regression text model (trained offline with scikit-learn), exported to JSON and evaluated in TypeScript worker threads | No external AI, no Python at runtime, no pickle; see `docs/ML_ARCHITECTURE.md` |
| URL parsing | WHATWG `URL` + `tldts` (public-suffix list, offline) | Correct registrable domains, no network |
| OCR | `tesseract.js` (WebAssembly) | In-process, no native binaries, no code execution |
| Email | `nodemailer` (SMTP); console/memory transports for dev/tests | |
| Tests | Vitest | |

There is no frontend framework: the frontend is static HTML/CSS/JS owned by the frontend developer. The backend lives entirely in `server/`.

## Request flow (`POST /api/analyze`)

```
routes/analyze.ts ── Zod validation (analysis/schemas.ts)
        │
        ▼
analysis/analysis-service.ts
        ├─ detection/detect.ts ─┬─ normalize.ts      (NFKC, invisible chars, Arabic unification, language)
        │                       ├─ text-rules.ts     (18 phrase rules + 2 obfuscation checks)
        │                       ├─ url-analyzer.ts   (21 static URL checks; never fetches)
        │                       └─ email-analyzer.ts (6 sender-consistency checks)
        ├─ ml/ml-service.ts ── MlEngine (engine.ts: WorkerPoolEngine | InProcessEngine)
        │      applicability (English text/email only) · timeout · bounded queue · output validation
        │      └─ inference-worker.ts → linear-model.ts (verified JSON model) + text-features.ts
        ├─ risk/risk-engine.ts  (deterministic rule score → low/medium/high/unknown)
        ├─ risk/hybrid.ts       (rule level + ML band → final level; ML never lowers, never HIGH alone)
        └─ risk/explain.ts      (deterministic explanation + recommendations)
        │
        ▼
repositories/ (only if save=true and signed in; evidence stripped) + anonymous daily stats
```

## Modules

```
server/
  index.ts              entry point (listen + graceful shutdown)
  bootstrap.ts          composition root: builds DB, mailer, ML engine, OCR from config
  app.ts                Fastify app: security headers, CORS, rate limits, auth hook, error handler
  config.ts             env parsing/validation (fails fast, never echoes values)
  lib/errors.ts         AppError + Zod helpers;  lib/limits.ts  rate-limit table
  analysis/             request schema + orchestration service
  detection/            rule engine, URL & email analyzers, brand data, normalisation
  risk/                 classification + explanations
  ml/                   model loader/verifier, TS feature port, inference worker, engine pool, ML service
  scripts/evaluate-hybrid.ts   rules vs ML vs hybrid evaluation on the prepared splits
ml/                     Python training pipeline (sources, download, prepare, train, tests), challenge
                        probes, and committed artifacts (ml/artifacts/<version>/)
  auth/                 crypto primitives, auth service, mailers
  repositories/         all SQL (parameterised), one class per table
  routes/               HTTP layer only (validation → service → response)
  ocr/                  file sniffing/validation, OCR queue + Tesseract engine
  reports/              text/JSON scan reports
  db/                   driver adapter, migration runner, migrations/*.sql, seed content
  scripts/              migrate, seed, promote-admin CLIs
tests/  unit/ integration/ security/ helpers/
```

## Design principles applied

- **Single responsibility / separation of concerns:** routes do HTTP only; services hold logic; repositories hold SQL; detectors are pure functions.
- **Dependency injection:** `buildApp(deps)` receives the database, mailer, ML service, and OCR service. Tests inject the real model (in-process) or failure doubles; production injects the worker-pool engine (`bootstrap.ts`).
- **Strategy pattern:** `MlEngine` and `OcrEngine` interfaces; `Mailer` interface.
- **Repository pattern:** `repositories/index.ts`.
- **Pure, testable core:** `runDetection`, `assessRisk`, `combineSignals`, `buildExplanation` have no I/O.

## Key decisions

1. **No new frontend framework, no frontend file changes.** The API response is a superset of the contract `checker.js` already validates (`risk`, `summary`, `warnings`, `recommendations`).
2. **Bearer tokens, not cookies.** The existing frontend sends `credentials: "omit"`; bearer tokens avoid CSRF entirely. Sessions are opaque random tokens stored only as SHA-256 hashes (revocable, server-side).
3. **Authentication is built from vetted primitives, not a custom protocol.** Argon2id hashing plus server-side opaque sessions (the pattern recommended by OWASP's Session Management guidance). A managed identity provider was not used because none is configured for this project; see Roadmap.
4. **Own ML model, not an external AI (2026-11-11).** The Anthropic integration was removed. The ML classifier is trained by us on documented public datasets and runs locally. In the hybrid decision it can raise the rule-based level by one step but can never lower it or produce HIGH by itself. The explanation shown to users is generated deterministically.
5. **Privacy by default.** Raw submissions are never persisted. Saved scans store results and indicator metadata without evidence excerpts. Guest scans are not stored.
6. **PGlite fallback.** Local development needs no database server; production refuses to start without `DATABASE_URL`.
7. **Unknown over false comfort.** If the model cannot run (failure or unsupported language) and the rules find nothing, the result is UNKNOWN, not LOW.
