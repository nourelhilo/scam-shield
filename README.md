# ScamShield

ScamShield is an explainable scam-detection platform for suspicious text messages, links, and emails. A browser interface (HTML, CSS, JavaScript) talks to a TypeScript/Node.js API. The API combines rule-based detection with **ScamShield's own machine-learning classifier**, which the team trained on public datasets and which runs locally inside the backend.

> **No external AI API is used.** Submitted content is never sent to Anthropic, OpenAI, Google, or any other AI provider, and the backend needs no API keys. A security test fails if an LLM SDK is added to the dependencies (`tests/security/security.test.ts`).

**Run locally:** install dependencies with `npm ci`, run `npm run dev`, and open [http://127.0.0.1:3000](http://127.0.0.1:3000). **Deploy:** follow the [production deployment guide](docs/DEPLOYMENT.md) for Docker or Node.js, PostgreSQL, SMTP, and HTTPS.

---

## 1. Project overview

Scam messages ("your parcel is on hold, pay a redelivery fee", fake bank alerts, look-alike login links) are designed to look routine. ScamShield lets a user paste a message, link, or email (or upload a screenshot) and get:

- a risk rating: `low`, `medium`, `high`, or `unknown`;
- the warning signs it found, each with the evidence from the submission;
- practical safety recommendations.

Results are an automated estimate. ScamShield never claims that something is definitely safe or definitely fraudulent, and it never visits links or contacts senders.

## 2. Features

Status terms: **verified** = automated tests pass and/or a recorded live run; **not verified** = implemented, but not exercised against the real external service. Evidence: [`docs/BACKEND_PROGRESS.md`](docs/BACKEND_PROGRESS.md).

### Implemented and verified

- Rule-based text detection in **English and Arabic** (18 rules + 2 obfuscation checks): urgency, threats, credential/OTP/bank/card requests, unusual payments, impersonation, fake deliveries, account suspension, prizes, investment and job scams, phishing calls to action. Negations are handled ("we will never ask for your password" is not flagged).
- Static URL analysis (21 rules): look-alike brands, punycode and mixed scripts, IP hosts, embedded credentials, misleading subdomains, redirects. URLs are never fetched.
- Pasted-email analysis: sender consistency checks (explicitly marked as unverifiable) plus text and link rules on subject and body.
- **ScamShield ML classifier** `scamshield-text-v1.0.0` (English), run in worker threads with timeout, heap limit, and bounded queue; word-level explanations; hybrid combination with the rules.
- Accounts: registration, email verification, login/logout/logout-all, password reset, change password, profile, account deletion (email delivery mocked in tests; see below).
- Opt-in scan history with filters, text/JSON report download, and deletion.
- Feedback API, educational articles API (7 seeded articles), admin API with role-based access and audit log.
- Security: input validation and size limits, rate limiting, security headers, CORS allow-list, log redaction, fail-fast configuration validation.
- The bundled analyzer and password-reset page work against the same-origin API.

### Implemented but not verified

- Delivery from the production SMTP provider and connectivity to the production PostgreSQL service. CI includes an isolated PostgreSQL and SMTP smoke test.
- Arabic screenshot OCR. English OCR with real Tesseract was verified manually once (2026-11-09).

### In progress

- Frontend for sign-in, history, feedback, and articles (see [`FRONTEND_INTEGRATION.md`](FRONTEND_INTEGRATION.md) section G).

### Planned

- Provision production hosting, managed PostgreSQL, and an SMTP provider.
- Shared rate-limit store for multiple instances; data-retention purge job; PDF reports.
- Arabic ML model (blocked: no openly licensed real Arabic scam data found); Arabic explanations.

## 3. Scam detection architecture

```mermaid
flowchart LR
    Page["index.html + checker.js"] -->|POST /api/analyze| API["Fastify API (server/)"]
    API --> Norm["Normalise\n(NFKC, invisible chars,\nArabic variants, language)"]
    Norm --> Rules["Rules\n(text, URL, email)"]
    Norm --> ML["ScamShield ML classifier\n(local worker threads)"]
    Rules --> Hybrid["Hybrid risk decision"]
    ML --> Hybrid
    Hybrid --> Explain["Deterministic explanation\n+ recommendations"]
    API --> DB[("PostgreSQL / PGlite")]
```

### Pipeline

1. **Normalise** the input: Unicode NFKC, remove invisible characters, unify Arabic letter variants and digits, detect the language.
2. **Rules.** Each rule has an ID, severity, description, and evidence. Request rules need a request verb near a sensitive noun.
3. **Links and sender.** Every URL is analysed statically. For emails, sender consistency is checked.
4. **Rule score.** low = 1, medium = 2, high = 3, with repeats in one category dampened. **HIGH** needs a score ≥ 6 across 2+ categories, or 2 high-severity indicators in different categories. **MEDIUM** needs a score ≥ 3 or one high-severity indicator.
5. **ML classifier** (English text and email subject + body only). It returns a probability, a band, and the words that moved the score. Bands: `low` < 0.2 · `uncertain` · `elevated` ≥ 0.5 · `strong` ≥ 0.9. URLs are left to the URL engine. Arabic and mixed text are left to the rules.
6. **Hybrid risk classification.** The rule level is the anchor. A `strong` ML score raises it one step (LOW→MEDIUM, MEDIUM→HIGH). An `elevated` score raises LOW→MEDIUM only when a rule also found something. ML **never lowers** a rule finding and **never produces HIGH on its own**. If the model cannot run and the rules found nothing, the result is **UNKNOWN**, because no findings is not proof of safety. No confidence percentages are shown.
7. **Explanation generation.** The explanation is built deterministically from the final indicators (no generative AI), with tailored recommendations. The ML explanation lists the terms from the submission that contributed most to the score.

### The ML model

| | |
|---|---|
| Model version | `scamshield-text-v1.0.0` (SHA-256 `75cbf788…db17d`) |
| Model type | Logistic regression (C = 64) over TF-IDF word 1–2-grams + character 3–5-grams (80,000 features) |
| Compared against | Linear SVM, multinomial naive Bayes; selected on the validation split ([training](docs/MODEL_TRAINING.md)) |
| Training data | UCI SMS Spam Collection, Mishra & Soni SMS Phishing dataset (Mendeley), Nazario phishing corpus, Apache SpamAssassin public corpus: 14,728 unique English messages after de-duplication ([sources and licences](docs/DATASET_SOURCES.md)) |
| Preprocessing | Lower-casing, links → `[link]`, numbers → `#`, normaliser `norm-v1`, identical in Python and TypeScript (parity-tested on 95 fixtures) |
| Inference | Plain-JSON model loaded and checksum-verified at startup (no pickle), run in Node worker threads; no Python at runtime |
| Held-out test (same public datasets, 2,946 messages) | accuracy 0.977, precision 0.989, recall 0.952, F1 0.970, false-positive rate 0.66% ([evaluation](docs/MODEL_EVALUATION.md)) |
| Hybrid on the same test | flags 91.0% of spam/phishing at 1.33% false-positive rate (rules alone flagged 14.7%) |

**Limitations:** these numbers describe the public datasets, not real-world accuracy. The model is English-only and was not validated on real ScamShield traffic. It over-flags some legitimate OTP, sign-in, and card alerts as MEDIUM. Details: [`docs/MODEL_LIMITATIONS.md`](docs/MODEL_LIMITATIONS.md), [`docs/ML_ARCHITECTURE.md`](docs/ML_ARCHITECTURE.md).

## 4. Technology stack

| Layer | Technology |
|---|---|
| Frontend | Static HTML, CSS, and vanilla JavaScript for the analyzer and password reset |
| Backend | TypeScript run directly by `tsx` on Node.js ≥ 22.12 · Fastify 5 (`@fastify/cors`, `helmet`, `multipart`, `rate-limit`) · Zod 4 · `tldts` |
| Database | PostgreSQL via `pg` in production; embedded PGlite (`@electric-sql/pglite`) for development and tests; plain SQL migrations |
| Auth | Argon2id (`@node-rs/argon2`), opaque random bearer tokens stored as SHA-256 hashes |
| Email | `nodemailer` (SMTP); console and in-memory mailers for development and tests |
| ML inference | Own TypeScript implementation (`server/ml/`) in `node:worker_threads` |
| ML training (offline) | Python 3 · scikit-learn · SciPy · NumPy · pandas · pytest (`ml/requirements.txt`) |
| OCR | `tesseract.js` (WebAssembly), optional |
| Testing & quality | Vitest · TypeScript `tsc --noEmit` · ESLint (`typescript-eslint`) |

## 5. Repository structure

```
.
├── index.html, styles.css, checker.js, retro-terminal.svg   # frontend (owned by the frontend developer)
├── reset-password.html, reset-password.js                  # password reset from emailed links
├── Dockerfile, .dockerignore, .github/workflows/ci.yml      # production image and CI
├── server/
│   ├── index.ts, bootstrap.ts, app.ts, config.ts            # entry point, wiring, Fastify app, env validation
│   ├── routes/          # analyze, auth, me, scans, feedback, articles, admin, health, frontend (static files)
│   ├── analysis/        # analysis service + request schemas
│   ├── detection/       # normalisation, text rules, URL analyzer, email analyzer, brand list
│   ├── risk/            # rule scoring, hybrid rules+ML decision, explanations
│   ├── ml/              # model loading, features, linear model, worker-pool engine
│   ├── auth/            # auth service, password/token crypto, mailer
│   ├── db/              # database driver (pg / PGlite), migrator, migrations/*.sql, seed data
│   ├── repositories/    # SQL data access
│   ├── ocr/             # Tesseract service, upload validation
│   ├── reports/         # text/JSON scan reports
│   ├── lib/             # errors, limits
│   └── scripts/         # migrate, seed, promote-admin, evaluate-hybrid
├── ml/
│   ├── scamshield_ml/   # Python pipeline: sources, download, prepare, features, train, export
│   ├── tests/           # pytest suite
│   ├── challenge/       # hand-written behaviour probes (not training data)
│   ├── artifacts/scamshield-text-v1.0.0/   # shipped model (model.json), manifest, metrics, parity fixtures
│   └── requirements.txt
├── tests/               # unit/, integration/, security/, helpers/, fixtures/
├── docs/                # API, architecture, database, ML, security, testing, progress
├── .env.example         # every supported environment variable
├── FRONTEND_INTEGRATION.md
├── FRIEND_HANDOFF.md
├── package.json, tsconfig.json, eslint.config.js, vitest.config.ts
```

Git-ignored local folders: `node_modules/`, `.env`, `.data/` (PGlite database), `.cache/` (OCR data), `ml/.venv/`, `ml/data/` (downloaded datasets).

## 6. Prerequisites

| Requirement | Version | Needed for |
|---|---|---|
| Node.js | **≥ 22.12** (`engines` in `package.json`; developed on v24.14.0) | Running the backend and tests |
| npm | Bundled with Node (developed on 11.9.0) | Installing dependencies |
| Git | any recent | Cloning |
| Python | 3 (artifact trained with 3.14.3) | **Only** for retraining or ML pipeline tests |
| PostgreSQL | 17 in the production smoke test | **Only** for production. Development uses embedded PGlite |

No other system packages are needed. OCR uses WebAssembly and downloads its language data on first use.

## 7. Installation

```sh
git clone https://github.com/nourelhilo/scam-shield.git
cd scam-shield
npm ci
```

Local defaults work without an environment file. To customize settings, copy `.env.example` to `.env` with `cp .env.example .env` on macOS/Linux or `Copy-Item .env.example .env` in PowerShell.

Optional, only to retrain the model or run the Python tests:

```sh
npm run ml:setup        # creates ml/.venv and installs ml/requirements.txt
```

## 8. Environment configuration

All variables are **server-only** and validated at startup in [`server/config.ts`](server/config.ts). An invalid value stops the server with an error naming the variable (values are never echoed). The full annotated template is [`.env.example`](.env.example). **No API keys or paid services are needed for local development.**

Legend: **Dev** = needed for local development · **Prod** = needed in production.

| Variable | Required? | Purpose | Example | Where to obtain |
|---|---|---|---|---|
| `NODE_ENV` | Prod: set to `production` | Mode; production enables strict checks and HSTS | `production` | Choose |
| `HOST` | Optional (default `127.0.0.1`) | Listen address | `0.0.0.0` | Choose (`0.0.0.0` in containers) |
| `PORT` | Optional (default `3000`) | Listen port | `3000` | Choose / set by host |
| `PUBLIC_APP_URL` | **Prod: required, `https://`** (dev default `http://127.0.0.1:3000`) | Base URL of the links in verification and reset emails | `https://scamshield.example.com` | Your domain / hosting URL |
| `CORS_ORIGINS` | Prod: required if the frontend is on another origin (prod default: none) | Comma-separated allowed browser origins | `https://app.example.com` | Frontend URL(s) |
| `SERVE_FRONTEND` | Optional (default `true`) | Serve the frontend files from the API origin | `true` | Choose |
| `LOG_LEVEL` | Optional (default `info`; `silent` in tests) | Log verbosity | `warn` | Choose |
| `TRUST_PROXY` | Optional (default `false`) | Trust `X-Forwarded-*` from a reverse proxy | `true` | `true` only behind your own proxy/load balancer |
| `DATABASE_URL` | **Prod: required, secret** (dev: empty = PGlite) | PostgreSQL connection string (`postgres://` or `postgresql://`) | `postgres://USER:PASSWORD@HOST:5432/scamshield` | Your PostgreSQL server or managed provider |
| `PGLITE_DATA_DIR` | Optional (default `.data/pglite`) | PGlite data folder (dev only) | `.data/pglite` | Choose |
| `DB_AUTO_MIGRATE` | Optional (default `false`) | Run migrations on startup for PostgreSQL (PGlite always does) | `false` | Choose |
| `REQUIRE_EMAIL_VERIFICATION` | Optional (default `true`) | Block sign-in until the email is verified | `true` | Keep `true` in production |
| `SESSION_TTL_HOURS` | Optional (default `168`, range 1–2160) | Sign-in token lifetime | `168` | Choose |
| `MAIL_TRANSPORT` | **Prod: must be `smtp`** (default `console`) | `console` prints emails to the terminal · `smtp` · `memory` (tests) | `smtp` | Choose |
| `SMTP_URL` | **Required when `MAIL_TRANSPORT=smtp`; secret** | SMTP server and credentials (`smtp://` or `smtps://`) | `smtps://USER:PASSWORD@smtp.example.com:465` | Your email provider's SMTP settings |
| `MAIL_FROM` | Prod: recommended (default `ScamShield <no-reply@scamshield.local>`) | Sender address | `ScamShield <no-reply@example.com>` | An address/domain your SMTP provider has verified |
| `ML_ENABLED` | Optional (default `true`) | Use the local ML classifier (`false` = rules only) | `true` | Choose |
| `ML_MODEL_DIR` | Optional (default `ml/artifacts/scamshield-text-v1.0.0`) | Model folder | — | Only artifacts produced by `npm run ml:pipeline` |
| `ML_ENGINE` | Optional (default `worker`) | `worker` (thread pool) or `in-process` | `worker` | Choose |
| `ML_WORKERS` | Optional (default `1`, range 1–8) | Inference threads | `2` | Choose by CPU cores |
| `ML_TIMEOUT_MS` | Optional (default `1500`, range 100–10000) | Per-request inference timeout | `1500` | Choose |
| `ML_MAX_QUEUE` | Optional (default `64`, range 1–1000) | Pending inferences before falling back to rules | `64` | Choose |
| `ML_WORKER_MAX_HEAP_MB` | Optional (default `256`, range 64–2048) | Heap limit per worker | `256` | Choose |
| `OCR_ENABLED` | Optional (default `false`) | Enable `POST /api/analyze/image` | `true` | Choose (downloads free Tesseract data on first use) |
| `OCR_LANGS` | Optional (default `eng+ara`) | Tesseract languages | `eng` | Choose |
| `OCR_CACHE_DIR` | Optional (default `.cache/tesseract`) | Language-data cache | `.cache/tesseract` | Choose |
| `OCR_TIMEOUT_MS` | Optional (default `30000`, range 1000–120000) | OCR timeout | `30000` | Choose |
| `UPLOAD_MAX_BYTES` | Optional (default `5242880`, max 10 MB) | Screenshot size limit | `5242880` | Choose |
| `RATE_LIMIT_ENABLED` | Optional (default `true`) | In-memory rate limiting | `true` | Keep `true` |
| `SCAMSHIELD_SLOW` | Optional, **ML tests only** (not read by the server) | `1` also runs the retrain-and-compare-hash test | `1` | Choose |

**Deprecated / not needed:** `ANTHROPIC_API_KEY`, `AI_PROVIDER`, `AI_MODEL` (from the removed Anthropic integration) are ignored. If they are set, the server logs a warning with the names only. Delete them. No `OPENAI_API_KEY`, `JWT_SECRET`, `SESSION_SECRET`, or other key is used anywhere in the code.

**Production checklist** (enforced at startup): `NODE_ENV=production` requires `DATABASE_URL`, `MAIL_TRANSPORT=smtp` with `SMTP_URL`, and an explicit `https://` `PUBLIC_APP_URL`.

## 9. Database setup

| | PGlite (development, tests) | PostgreSQL (production) |
|---|---|---|
| Selected when | `DATABASE_URL` is empty | `DATABASE_URL` is set |
| Storage | `.data/pglite` (in-memory in tests) | Your server |
| Migrations | Applied automatically at startup, and articles seeded | `npm run db:migrate`, then `npm run db:seed` (or `DB_AUTO_MIGRATE=true`) |
| Verification | Unit and integration suite | Image smoke test with PostgreSQL 17 |

Migrations (`server/db/migrations/*.sql`) are forward-only, recorded in a migrations table, applied in transactions, and never drop data. All queries are parameterised. Schema: [`docs/DATABASE_SCHEMA.md`](docs/DATABASE_SCHEMA.md).

Set all [production variables](docs/DEPLOYMENT.md) before running the release commands:

```sh
npm run db:migrate
npm run db:seed
npm run admin:promote -- you@example.com     # after registering, grant yourself admin (--revoke to undo)
```

## 10. Machine learning setup

The trained model is committed in `ml/artifacts/scamshield-text-v1.0.0/` and **loads automatically**. You do not need Python to run the server.

- **Model loading:** at startup the backend reads `model.json`, checks its SHA-256 against `manifest.json`, and validates its format and normaliser version. A tampered or incompatible artifact is refused, and the API falls back to rules with `mlPrediction.status: "unavailable"`.
- **Local inference:** worker threads (`ML_ENGINE=worker`) with timeout, heap limit, and bounded queue; a crashed or stuck worker is replaced.

Retraining and evaluation (downloads public datasets, checksum-verified, no credentials or payment needed):

| Command | What it does |
|---|---|
| `npm run ml:setup` | Create `ml/.venv` with pinned packages |
| `npm run ml:download` | Download the four public datasets (verified by SHA-256) into `ml/data/` |
| `npm run ml:prepare` | Parse, label, de-duplicate, and split into train/validation/test |
| `npm run ml:train` | Train and compare model families, export `model.json` + metrics |
| `npm run ml:evaluate-hybrid` | Evaluate the rules+ML hybrid on the splits |
| `npm run ml:pipeline` | All of the above in order |
| `npm run ml:test` | Python pipeline tests (`SCAMSHIELD_SLOW=1` also retrains and compares the hash) |

Training is reproducible: retraining produced a byte-identical `model.json`. Full guide: [`docs/MODEL_TRAINING.md`](docs/MODEL_TRAINING.md). Results: [`docs/MODEL_EVALUATION.md`](docs/MODEL_EVALUATION.md).

## 11. Running the application

```sh
npm run dev      # API with auto-reload on http://127.0.0.1:3000
npm start        # same, without auto-reload
```

Open **http://127.0.0.1:3000**. The API serves the existing frontend files from the same origin and points the analyzer at `/api/analyze` (the file on disk is not modified). Health check: `GET /api/health`.

For a separately hosted frontend, publish only the intended frontend assets and see [Frontend integration](#16-frontend-integration).

There is no build step: TypeScript runs directly through `tsx`.

## 12. API documentation

| Area | Endpoints |
|---|---|
| Analysis | `POST /api/analyze` (`text`, `url`, `email`) · `POST /api/analyze/image` (OCR, needs `OCR_ENABLED=true`) |
| Auth | `POST /api/auth/register` · `/login` · `/logout` · `/logout-all` · `/verify-email` (also `GET`) · `/resend-verification` · `/password-reset/request` · `/password-reset/confirm` · `/change-password` |
| Profile | `GET` / `PATCH` / `DELETE /api/me` |
| History | `GET /api/scans` · `GET /api/scans/:id` · `GET /api/scans/:id/report` · `DELETE /api/scans/:id` · `DELETE /api/scans` |
| Feedback | `POST /api/feedback` |
| Articles | `GET /api/articles` · `GET /api/articles/:idOrSlug` |
| Admin | `GET /api/admin/metrics` · `/health` · `/rules` · `/feedback` · `PATCH /api/admin/feedback/:id` · `/api/admin/articles` (CRUD) · `GET /api/admin/audit-logs` |
| Health | `GET /api/health` |

Minimal analysis call:

```sh
curl -s http://127.0.0.1:3000/api/analyze -H 'content-type: application/json' \
  -d '{"type":"text","content":"Your delivery is on hold. Pay a redelivery fee at http://parcel-fee.example"}'
```

The response always contains `risk`, `summary`, `warnings`, and `recommendations` (what `checker.js` uses), plus richer fields such as `riskLevel`, `indicators`, `analysisMethod` (`rules` or `rules+ml`), `mlPrediction`, and `modelExplanation`.

- Frontend guide with examples: [`FRONTEND_INTEGRATION.md`](FRONTEND_INTEGRATION.md)
- Field-level reference and rule catalogue: [`docs/API_DOCUMENTATION.md`](docs/API_DOCUMENTATION.md)

## 13. Authentication and email

- **Registration:** email + password; passwords hashed with Argon2id (OWASP parameters). Responses do not reveal whether an email is already registered.
- **Email verification:** a single-use token valid for 24 hours, emailed as `PUBLIC_APP_URL/api/auth/verify-email?token=…`. Sign-in is blocked until verified when `REQUIRE_EMAIL_VERIFICATION=true`.
- **Login:** returns an opaque bearer token (only its SHA-256 hash is stored), sent as `Authorization: Bearer <token>`, valid for `SESSION_TTL_HOURS`.
- **Password reset:** a single-use token valid for 30 minutes, emailed as `PUBLIC_APP_URL/reset-password?token=…`. The bundled reset page submits the new password to the API.
- **Email service:** in development, `MAIL_TRANSPORT=console` prints email links to the terminal. In production, set `MAIL_TRANSPORT=smtp`, `SMTP_URL`, and a verified `MAIL_FROM`. Check delivery from your configured provider before launch.

Accounts are optional: analysis works without signing in.

## 14. Testing

```sh
npm test            # Vitest: unit, integration, security
npm run typecheck   # tsc --noEmit
npm run lint        # ESLint
npm run check       # all three
npm run ml:test     # Python ML tests (after npm run ml:setup)
```

The main suite uses the **real trained model** and in-memory PGlite. CI also runs the production image against PostgreSQL and Mailpit to exercise the analyzer, migrations, registration, verification, sign-in, and password reset. See [test coverage](docs/TESTING.md).

## 15. Security and privacy

Implemented: raw submissions are never stored (history is opt-in and stores results only); URLs are never fetched (SSRF-tested); strict input validation and size limits; upload type sniffing (PNG/JPEG/WebP only); rate limits; security headers via Helmet (HSTS in production); CORS allow-list; log redaction (no submitted content or secrets in logs); parameterised SQL; hashed passwords and tokens; checksum-verified model loading without pickle; configuration errors never echo values.

Known limitations: rate limiting is in-memory per process; pasted email headers cannot be authenticated (no SPF/DKIM/DMARC); no data-retention purge job yet. Details: [`docs/SECURITY.md`](docs/SECURITY.md).

## 16. Frontend integration

- **Same origin (simplest):** run `npm run dev` and open `http://127.0.0.1:3000`. Nothing to configure.
- **Separate origin:** set `data-analysis-endpoint` on `#scan-form` in `index.html` to `http://127.0.0.1:3000/api/analyze`, and list the frontend origin in `CORS_ORIGINS` (the dev defaults already include `http://127.0.0.1:4173` and `http://localhost:4173`).

The frontend needs only the API location. Never put any `.env` value in frontend code. Full guide, response shapes, error handling, and the prioritised to-do list: [`FRONTEND_INTEGRATION.md`](FRONTEND_INTEGRATION.md).

## 17. Development roadmap

Current phase: **backend and ML complete for local use; frontend expansion and production verification in progress.**

1. Frontend: sign-in/register, reset requests, history, feedback, and articles.
2. Deploy to staging and verify PostgreSQL connectivity, SMTP delivery, and HTTPS links with the configured providers.
3. Add a shared rate-limit store before scaling to multiple app instances.
4. Model: licensed real Arabic data and modern legitimate-notification data; probability calibration; consented, admin-reviewed feedback for evaluation.
5. Arabic explanations; data-retention job; PDF reports.

## 18. Known limitations

- The ML model is English-only and evaluated only on public datasets; real-world accuracy is unknown.
- Legitimate OTP, sign-in, and card alerts can be rated MEDIUM.
- Production provider connectivity and Arabic OCR accuracy require verification.
- Rate limiting is per process; multiple instances need a shared store.
- Explanations are English only (Arabic input is analysed by the rules).
- Pasted email sender details cannot be verified.
- Reports are plain text/JSON (no PDF). Rule thresholds are hand-tuned.

## 19. License

**No license file is included in this repository**, so no open-source license has been granted: by default all rights are reserved by the authors. Adding a license is a decision for the repository owner. The training datasets have their own licences, listed in [`docs/DATASET_SOURCES.md`](docs/DATASET_SOURCES.md).
