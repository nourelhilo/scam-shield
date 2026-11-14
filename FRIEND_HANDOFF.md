# Handoff: ScamShield backend → frontend

Date: 2026-11-14 (previous handoffs: 2026-11-11, 2026-11-09)

## TL;DR

- **You do not need to change anything in the frontend.** `checker.js` still gets the same `risk`, `summary`, `warnings`, and `recommendations`, and the three "Try an example" samples still work. None of your files (`index.html`, `styles.css`, `checker.js`, `retro-terminal.svg`) were modified in this or any backend change.
- The backend uses **our own machine-learning model** plus rules. No Anthropic / Claude / OpenAI or other external AI, and **no API keys at all**.
- **You need no `.env` to run locally.** Every setting has a working default.
- New since 2026-11-11: the README was rewritten, `.env.example` now documents every supported variable, and production startup is stricter (see section 3). Nothing changed for local development.

## 1. Current status

| Area | Status |
|---|---|
| Analysis API (`/api/analyze`, text / URL / email) | Done, tested; your analyzer works with it unchanged |
| ScamShield ML model `scamshield-text-v1.0.0` | Done, tested with the real model; English only |
| Accounts (register, verify email, login, reset password, profile, delete) | Done, tested with a fake mailer; **real email sending not verified** |
| Scan history, reports, feedback, articles, admin API | Done, tested |
| Screenshot OCR (`/api/analyze/image`) | Done; off by default (`OCR_ENABLED=true` to turn on) |
| Database | Embedded PGlite locally (automatic). **Real PostgreSQL not verified yet** |
| Deployment | **Not done** |

Latest checks (2026-11-14): `npm run typecheck` pass, `npm run lint` pass, `npm test` **457 passed, 0 failed**.

## 2. Exact setup commands

```sh
git pull origin main
npm ci
npm run dev          # http://127.0.0.1:3000 serves your page + the API
```

Needs Node.js 22.12 or newer (`node -v`). Python is **not** needed; the trained model is already in `ml/artifacts/`.

If you have an old `.env` with `ANTHROPIC_API_KEY`, `AI_PROVIDER`, or `AI_MODEL`, delete those lines. They are ignored, and the server logs a warning about them.

Optional `.env` (only if you want to change defaults):

```sh
cp .env.example .env
```

## 3. Local configuration you might touch

| Variable | When you would change it |
|---|---|
| `CORS_ORIGINS` | You serve the frontend from a port other than 4173 or 3000, e.g. `http://127.0.0.1:5500` (VS Code Live Server). Comma-separated. |
| `OCR_ENABLED=true` | You build the screenshot upload. First use downloads free Tesseract data. |
| `REQUIRE_EMAIL_VERIFICATION=false` | You want to test sign-in without clicking verification links. Keep `true` otherwise. |

Emails (verification and reset) are **printed in the terminal running `npm run dev`**. Copy the link from there.

Production-only settings (`DATABASE_URL`, `SMTP_URL`, an `https://` `PUBLIC_APP_URL`) are the backend's job. The server refuses to start in production without them. Full table: [README section 8](README.md#8-environment-configuration).

## 4. Connecting the frontend (no design changes)

- **Same origin (recommended):** `npm run dev`, open http://127.0.0.1:3000. The served copy of `index.html` points the analyzer at `/api/analyze`; your file on disk is untouched.
- **Separate origin:** set `data-analysis-endpoint="http://127.0.0.1:3000/api/analyze"` on `#scan-form` and make sure your origin is in `CORS_ORIGINS`.
- New features (sign-in, history, …): call the endpoints in [FRONTEND_INTEGRATION.md](FRONTEND_INTEGRATION.md) section B; send `Authorization: Bearer <token>` after login.
- Never put any `.env` value in frontend code. The frontend only needs the API location.

## 5. How the model works (short version)

1. The text is normalised: lower-case, links become "[link]", numbers become "#", and so on.
2. A logistic-regression model scores how much it resembles spam, phishing, and smishing messages from four public datasets (about 14,700 messages).
3. The score becomes a band: `low` < 0.2, `uncertain`, `elevated` ≥ 0.5, `strong` ≥ 0.9.
4. It is combined with the rules. The rules stay in charge, and the model can only push the level **up** one step. It never makes a result HIGH by itself and never lowers a rule finding.
5. The response lists the words that moved the score most (`modelExplanation`).

It only runs on **English** text and emails. Links go to the URL checks, Arabic text goes to the Arabic rules, and images are first converted to text by OCR.

## 6. API fields that stay compatible

Unchanged: `risk`, `summary`, `warnings`, `recommendations`, `riskLevel`, `explanation`, `indicators`, `language`, `email`, `disclaimer`, `saved`, `scanId`, `analysisId`, `status`, `inputType`, `createdAt`, all error codes, and every endpoint.

Things you might notice:

- `warnings` can contain one line from the model, e.g. "ScamShield's machine-learning model found the wording very similar to … This is a statistical resemblance, not proof." It is a normal string.
- `indicators` may include an entry with `source: "ml"`.
- `unknown` also appears when the model could not run **and** the rules found nothing (typical: an ordinary Arabic message). Your "Unknown risk" label already handles it.
- `ai` is still in the response for compatibility, always `{ status: "not_configured", reason: "external_ai_removed" }`. Don't use it.
- Optional new fields you can ignore: `mlPrediction`, `modelExplanation`, `modelVersion`, `ruleIndicators`, `hybrid`, `analysisMethod` (`"rules"` or `"rules+ml"`).

## 7. Verify the three example scans

Open http://127.0.0.1:3000, click each "Try an example" sample, and press **Analyze for scam**. Recorded on 2026-11-11 against the live server:

| Example | Expected risk | Model used? |
|---|---|---|
| Text: "Your delivery is on hold. Pay a redelivery fee…" | **High** | yes (`rules+ml`) |
| URL: `https://account-verify.example/confirm-password` | **Medium** | no: links use the URL checks (`rules`) |
| Email: "Subject: Immediate action required…" | **High** | yes (`rules+ml`) |

`tests/integration/analyze.test.ts` replays `checker.js`'s acceptance check against these three responses on every test run (passed 2026-11-14).

## 8. Known blockers

- Validate the configured PostgreSQL and SMTP providers on the staging host. See the [deployment guide](docs/DEPLOYMENT.md).
- The model is English-only (no openly licensed real Arabic scam data found) and over-flags some legitimate OTP / sign-in / card alerts as Medium.
- Not deployed.

## 9. What to do next (in order)

1. Pull and run the three examples above (5 min).
2. Sign-in / register forms (`/api/auth/register`, `/login`, `/logout`, `/api/me`).
3. **Password-reset request form** using `/api/auth/password-reset/request`. The emailed link opens the bundled reset page.
4. Scan history (`save: true` on analyze, `/api/scans*`), then feedback and articles.
5. Optional: show `modelExplanation` words, the limitation notes below, and screenshot upload.

Acceptance criteria for each: [FRONTEND_INTEGRATION.md](FRONTEND_INTEGRATION.md) section G. If any response shape is awkward for your UI, tell me and I'll change the backend, not your design.

## 10. Limitations worth showing users

1. "ScamShield's model spots messages that *look like* known scams. It can't prove a message is fraudulent or safe."
2. "Legitimate alerts from your bank or apps (codes, sign-in alerts) can sometimes be flagged. Check them in the official app."
3. "Arabic messages are checked with our rules only; our model doesn't support Arabic yet."
4. "We never open links or contact the sender, and we don't keep your message."

Full list: [docs/MODEL_LIMITATIONS.md](docs/MODEL_LIMITATIONS.md).
