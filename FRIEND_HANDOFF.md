# Handoff: ScamShield backend → frontend

Date: 2026-11-09

## Project overview

ScamShield checks suspicious messages, links, and emails and explains the risk. You built the frontend (`index.html`, `styles.css`, `checker.js`, `retro-terminal.svg`). The backend now exists in `server/`. **None of your frontend files were modified.**

## Current development status

- Backend implemented across all planned stages: analysis, AI integration, database, auth, history, feedback, admin, articles, OCR, and reports.
- Verified with 301 passing automated tests, a clean type check and lint, and a live server smoke test.
- **Your current page works with the backend as-is.** The response contains the exact fields `checker.js` reads.
- Not deployed anywhere. Runs locally.

## Completed backend features (tested)

- `POST /api/analyze` for text, URL, and email, with English and Arabic rule-based detection, static URL analysis, and email sender checks.
- Risk levels `low` / `medium` / `high` / `unknown` with evidence, explanation, and recommendations.
- Optional AI layer (Anthropic). Without a key it reports `analysisMethod: "rules"`.
- Accounts: register, email verification, login/logout, password reset and change, profile, account deletion.
- Opt-in scan history with filters and downloadable reports.
- Feedback, educational articles (7 seeded), and admin API with audit log.
- Screenshot OCR endpoint (off by default).
- Security: validation, size limits, rate limits, security headers, CORS, log redaction, no stored submissions.

## Unfinished or unverified

- Real AI calls (no API key used), real SMTP email, Arabic OCR, and a standalone PostgreSQL server are **unverified**. Tests use mocks and an in-memory PostgreSQL (PGlite).
- Explanations are English only.
- Rate limiting is per process (fine locally, not for multiple servers).
- No PDF reports; no data-retention job; not deployed.

## API integration instructions

Read **[FRONTEND_INTEGRATION.md](FRONTEND_INTEGRATION.md)**. It covers every endpoint, examples, error handling, and a prioritised checklist. The quickest path:

```sh
npm install
npm run dev        # open http://127.0.0.1:3000 — your page, wired to the API
```

Or keep using `python -m http.server 4173` and set `data-analysis-endpoint="http://127.0.0.1:3000/api/analyze"` on `#scan-form`. That attribute is the **only** change needed. I left it for you because it's in your file.

## Important files

| File | Why it matters to you |
|---|---|
| `FRONTEND_INTEGRATION.md` | Everything you need to connect the UI |
| `docs/API_DOCUMENTATION.md` | Field-level reference and error codes |
| `server/routes/` | Where each endpoint is defined, if you want to check behaviour |
| `server/routes/frontend.ts` | How the API serves your files in development (allow-list, read-only) |
| `.env.example` | Server configuration. None of it belongs in frontend code. |

## Required environment variables

None for local development; the defaults work. For the frontend you only need the API location (same origin `/api/...`, or an origin listed in `CORS_ORIGINS`). Never put `ANTHROPIC_API_KEY`, `DATABASE_URL`, or `SMTP_URL` in frontend code.

## Setup instructions

1. Install Node.js 22.12+.
2. `npm install`
3. `npm run dev`. Verification emails are printed in this terminal during development; click the link to verify.
4. To test admin screens: register, then `npm run admin:promote -- your@email`.

## Testing results (2026-11-09)

| Command | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run lint` | pass |
| `npm test` | 301 passed, 0 failed (unit 203, integration 56, security 42) |
| Live smoke test with curl | health, analyze, page serving, register → verify → login, save, history, report, articles, CORS all OK |
| Real Tesseract OCR (English screenshot) | OK |

## Known bugs

No known failing behaviour. Known limitations are listed above and in `docs/BACKEND_PROGRESS.md`. One deliberate quirk: a look-alike domain with no other warning signs (e.g. `https://paypa1.com/`) rates **medium**, not high, because one high-severity finding alone is capped at medium by design.

## Git status

- Base: `b1886f9` "Add ScamShield frontend" (your commit), unchanged.
- Backend work is the commit after it on `main`: `feat: implement ScamShield backend and API services`. Run `git log --oneline -2` to see its hash.

## Exact next steps for you

1. Pull `main`, run `npm install && npm run dev`, and confirm the three "Try an example" samples show results (checklist item 1 in `FRONTEND_INTEGRATION.md`).
2. Decide whether to serve the page from the API (no change) or set `data-analysis-endpoint`.
3. Build sign-in/register forms, then the password-reset page at `/reset-password?token=…`.
4. Add scan history, the feedback control, and the articles section, in the order given in `FRONTEND_INTEGRATION.md` section G.
5. Tell me if any response field is awkward for the UI. I'll adapt the backend rather than you changing the design.
