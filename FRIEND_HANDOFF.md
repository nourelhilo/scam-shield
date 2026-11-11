# Handoff: ScamShield backend → frontend

Date: 2026-11-11 (previous handoff: 2026-11-09)

## TL;DR

- **You do not need to change anything in the frontend.** `checker.js` still gets the same `risk`, `summary`, `warnings`, and `recommendations`, and the three "Try an example" samples still work. None of your files (`index.html`, `styles.css`, `checker.js`, `retro-terminal.svg`) were modified.
- The backend **no longer uses Anthropic / Claude or any external AI**. It now uses **our own machine-learning model**, trained on public datasets, which runs inside the backend.

## 1. What changed in the backend

| Before | Now |
|---|---|
| Rule-based detection + optional Anthropic AI (needed an API key) | Rule-based detection + **ScamShield's own ML classifier** (no key, no external calls) |
| `analysisMethod`: `"rules"` or `"rules+ai"` | `"rules"` or `"rules+ml"` |
| `server/ai/` and `@anthropic-ai/sdk` | Removed. New `server/ml/` (inference) and `ml/` (Python training pipeline + trained model) |
| `ai` object in the response | Still present for compatibility, always `{ status: "not_configured", reason: "external_ai_removed" }`. Don't use it. |

New optional response fields (you can ignore all of them): `mlPrediction`, `modelExplanation`, `modelVersion`, `ruleIndicators`, `hybrid`. Details are in [FRONTEND_INTEGRATION.md](FRONTEND_INTEGRATION.md#c2-analysis-results-optional-enhancements).

## 2. Why the external AI was removed

- No user text leaves our server any more: better privacy, and no AI privacy notice is needed.
- No API key, no per-request cost, and no dependency on an outside service being up.
- The model is ours: we can show how it was trained, what data it used, and measured results ([docs/MODEL_EVALUATION.md](docs/MODEL_EVALUATION.md)).

## 3. How the model works (short version)

1. The text is normalised: lower-case, links become "[link]", numbers become "#", and so on.
2. A logistic-regression model scores how much it resembles spam, phishing, and smishing messages from four public datasets (about 14,700 messages).
3. The score becomes a band: `low` < 0.2, `uncertain`, `elevated` ≥ 0.5, `strong` ≥ 0.9.
4. It is combined with the existing rules. The rules stay in charge, and the model can only push the level **up** one step. It can never make a result HIGH by itself, and it never lowers a rule finding.
5. The response lists the words that moved the score most (`modelExplanation`).

It only runs on **English** text and emails. Links go to the URL checks, and Arabic text goes to the Arabic rules. Images are first converted to text by OCR.

## 4. API fields that stay compatible

Unchanged meaning and format: `risk`, `summary`, `warnings`, `recommendations`, `riskLevel`, `explanation`, `indicators`, `language`, `email`, `disclaimer`, `saved`, `scanId`, `analysisId`, `status`, `inputType`, `createdAt`, all error codes, and every other endpoint.

Small changes you might notice:

- `warnings` can now contain one extra line when the model finds the wording scam-like, for example: "ScamShield's machine-learning model found the wording very similar to … This is a statistical resemblance, not proof. (“words that weighed most: your, verify, [link]”)". It is a normal non-empty string, so `checker.js` displays it like the others.
- `indicators` may include an entry with `source: "ml"` and `category: "statistical"`.
- The `unknown` risk now also appears when the model could not run **and** the rules found nothing. Typical case: an ordinary **Arabic** message, because the model is English-only. Your existing "Unknown risk" label already handles it.
- `disclaimer` now mentions the machine-learning model.

## 5. Do you need to change anything?

**No.** Optional ideas, only if you want them:

- Show `mlPrediction.interpretation` or `modelExplanation.towardSuspicious[].display` as "words that raised the score".
- Show a small "Analysed with ScamShield's own model" note when `analysisMethod === "rules+ml"`.
- Show the limitation notes from section 9 near results.

If anything in the response is awkward for the UI, tell me and I'll change the backend, not your design.

## 6. Start the backend locally

```sh
git pull origin main
npm install
npm run dev          # http://127.0.0.1:3000 serves your page + the API
```

Python is **not** needed to run it; the trained model is already in `ml/artifacts/`. Remove `ANTHROPIC_API_KEY` from your `.env` if you had one (it's ignored now and the server logs a warning).

## 7. Verify the three example scans

Open http://127.0.0.1:3000, click each "Try an example" sample, and press **Analyze for scam**. Verified on 2026-11-11 against the live server:

| Example | Expected risk | Model used? |
|---|---|---|
| Text: "Your delivery is on hold. Pay a redelivery fee…" | **High** | yes (`rules+ml`, score 0.97) |
| URL: `https://account-verify.example/confirm-password` | **Medium** | no: links use the URL checks (`rules`) |
| Email: "Subject: Immediate action required…" | **High** | yes (`rules+ml`, score 0.9999) |

The automated test `tests/integration/analyze.test.ts` replays `checker.js`'s acceptance check against these three responses.

## 8. What is still unfinished

- The model is **English only**. No openly licensed real Arabic scam data was found.
- The model over-flags some **legitimate automated messages** (OTP codes, sign-in alerts, card alerts) as Medium.
- The model was evaluated on public datasets only, not on real ScamShield traffic.
- Unchanged from before: real SMTP and a real PostgreSQL server unverified; Arabic OCR unverified; per-process rate limiting; not deployed.
- Frontend work from the previous handoff (sign-in, history, feedback, articles, reset page) is still open. See FRONTEND_INTEGRATION.md section G.

## 9. Limitations worth showing users

Short copy you could use:

1. "ScamShield's model spots messages that *look like* known scams. It can't prove a message is fraudulent or safe."
2. "Legitimate alerts from your bank or apps (codes, sign-in alerts) can sometimes be flagged. Check them in the official app."
3. "Arabic messages are checked with our rules only; our model doesn't support Arabic yet."
4. "We never open links or contact the sender, and we don't keep your message."

Full list: [docs/MODEL_LIMITATIONS.md](docs/MODEL_LIMITATIONS.md).

## Testing results (2026-11-11)

| Command | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run lint` | pass |
| `npm test` | **455 passed**, 0 failed (unit 337, integration 74, security 44), using the real model |
| `npm run ml:test` | 25 passed, 1 slow test skipped by default (ran separately: retraining reproduces the identical model hash) |
| Live server smoke test | health shows `ml: true`; the three examples gave High / Medium / High; logs contain no submitted text |

## Git status

Base: `46dc598` ("Edit read me", your README change, kept as is). The ML work is the commit after it on `main`: `feat: replace external AI with custom ML scam classifier`.
