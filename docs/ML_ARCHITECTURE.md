# ML Architecture

ScamShield classifies text with **its own trained model**. No external AI or LLM service (Anthropic, OpenAI, Gemini, or any other) is called. The previous optional Anthropic integration has been removed from the code and the dependencies.

## Components

```
                    training (offline, Python)                          serving (Node.js backend)
 ┌───────────────────────────────────────────────────────┐   ┌──────────────────────────────────────────────┐
 │ ml/scamshield_ml/                                     │   │ server/ml/                                    │
 │  sources.py   pinned URLs + SHA-256                   │   │  text-features.ts  port of text.py (spec)     │
 │  download.py  verified download                       │   │  linear-model.ts   load + verify + predict    │
 │  data.py      per-source loaders, label mapping       │   │  inference-worker.ts  worker-thread entry     │
 │  text.py      normalisation + analyzers  (SPEC)       │   │  engine.ts         worker pool / in-process   │
 │  prepare.py   dedupe, near-dup groups, split          │   │  ml-service.ts     applicability, timeout,    │
 │  train.py     3 model families, selection, export ────┼──►│                    validation, status         │
 │  linear_model.py  JSON export + reference predictor   │   │ server/risk/hybrid.ts  rules + ML decision    │
 └───────────────────────────────────────────────────────┘   └──────────────────────────────────────────────┘
                     ml/artifacts/scamshield-text-v1.0.0/
                     model.json (plain JSON) · manifest.json (SHA-256) · metrics.json
                     hybrid_metrics.json · parity_fixtures.json · challenge_hybrid_results.json
```

## Why this architecture

The prompt preferred a Python inference process. We chose **a portable linear model exported to JSON and evaluated in TypeScript inside worker threads**. It is simpler and safer, and the tests show it is exact:

| Requirement | How it is met |
|---|---|
| Real local inference | The trained weights are applied to the submitted text on every request. Nothing is hard-coded or mocked in production. |
| No execution of untrusted serialised models | The artifact is plain JSON (terms, IDF values, weights, thresholds). No pickle or joblib is ever loaded, in Python or Node. |
| Artifact integrity | `model.json` must match the SHA-256 in `manifest.json`, then pass a strict Zod schema. Otherwise the model is refused and the API reports `ml: unavailable`. |
| Same results as scikit-learn | The export is checked against scikit-learn during training (max \|Δp\| 1.5e-9). The TypeScript port is checked against 95 parity fixtures (max \|Δp\| < 1e-9 in tests; 4e-15 measured). |
| Load the model once | Each worker thread loads it once at startup (about 30 ms, 80,000 features). |
| Timeouts | Per-request timeout (`ML_TIMEOUT_MS`, default 1,500 ms). A worker that does not answer is **terminated and replaced**. |
| Memory limits | Each worker runs with a V8 heap limit (`ML_WORKER_MAX_HEAP_MB`, default 256). A worker over the limit is killed, reported as `engine_error`, and replaced. |
| No unbounded queue | `ML_MAX_QUEUE` (default 64). Beyond it requests fail fast with `queue_full`, and the rules result is used. |
| Crash safety | Worker exits are detected, the in-flight request fails, and the worker respawns. More than 5 crashes in 60 s marks the engine unavailable. |
| No Python at runtime | Deployment needs only Node.js. Python is needed only to retrain. |
| Concurrency | The pool size is `ML_WORKERS` (default 1). Inference takes about 0.3–2.3 ms, so one worker serves hundreds of requests per second. |

A Python subprocess would have added an interpreter dependency, an IPC protocol, and pickle loading, without improving accuracy for a linear model.

## Model

- **Features:** word unigrams and bigrams (30,000 most frequent in train) plus character 3–5-grams inside space-padded words (50,000). Each block uses sublinear TF-IDF and is L2-normalised separately.
- **Classifier:** logistic regression (liblinear, C = 64), selected on validation from three families (see MODEL_TRAINING.md).
- **Output:** probability of the "suspicious" class, which is mapped to a band:

| Band | Probability | How it was set |
|---|---|---|
| `low` | < 0.20 | Validation suggested < 0.44; capped at 0.20 by policy |
| `uncertain` | 0.20 – 0.50 | |
| `elevated` | 0.50 – 0.90 | 0.5 = default decision threshold |
| `strong` | ≥ 0.90 | Validation precision was already ≥ 0.98 at 0.50; floored at 0.90 by policy |

The policy floors exist because in-distribution validation overstates real-world precision. The challenge probes show strong scores on some legitimate notifications.

## Normalisation (the shared specification)

`ml/scamshield_ml/text.py` is the specification. `server/ml/text-features.ts` mirrors it character for character, in this order:

1. NFKC.
2. Remove invisible characters.
3. Strip Latin accents.
4. Convert Arabic-Indic digits to ASCII.
5. Unify Arabic spellings (diacritics, tatweel, alef forms, ى→ي, ة→ه).
6. Lower-case ASCII letters.
7. Collapse whitespace.
8. Replace email addresses → `emailtoken`, links → `urltoken`, currency symbols → `moneytoken`, digits → `0`.
9. Turn every other character except `!` into a space.
10. Cap at 10,000 characters.

Every regular expression uses explicit character classes, so Python and JavaScript behave identically. `NORMALIZER_VERSION` is stored in the model and checked on load.

## When the model runs

| Input | Model applied? | Why |
|---|---|---|
| `text` (and OCR text from `/api/analyze/image`) | Yes, if English and at least 3 words / 12 characters | |
| `email` | Yes, on subject + body only (pasted headers excluded) | Matches the training layout |
| `url` | **No** (`not_applicable: input_type_url`) | Not trained on bare URLs; the URL engine handles links |
| Arabic or mixed-language text | **No** (`not_applicable: unsupported_language`) | No real Arabic training data exists; the model's Arabic scores were meaningless in probes (a legitimate Arabic OTP message scored 1.0) |
| Images | Only the OCR-extracted text | The model does not understand images |

## Hybrid decision

See `server/risk/hybrid.ts` and MODEL_EVALUATION.md. The rule level is the anchor. ML can raise it by at most one step and never lowers it, and HIGH always requires rule-based MEDIUM first. When the model cannot run and the rules find nothing, the result is UNKNOWN, not LOW.

## Explanations

For a linear model, each feature's contribution to the log-odds is exactly `value × weight`. ScamShield attributes those contributions to the submission's own words:

- Word n-grams are split evenly across their tokens.
- Character n-grams are added to the word they came from.

The returned terms add up exactly to the decision score (tested to 1e-9). Every term is a normalised token of the submission or a placeholder (`[link]`, `[number]`, …); nothing is invented. Limitations: the terms show what the model reacted to, not why a message is fraudulent, and character-pattern credit is folded into whole words.

## Versioning

- Model version `scamshield-text-v1.0.0`. The directory name, `model.json`, `manifest.json`, and `DEFAULT_MODEL_VERSION` in `server/ml/model-path.ts` must agree; the loader checks this.
- `ML_MODEL_DIR` can point to another **locally trained** artifact directory. Only use artifacts you produced with `npm run ml:train`.
- Each saved scan records `ml_status` and `model_version` (migration `002_ml_classifier.sql`).
- To ship a new model: train into a new version directory, review its metrics, then update `DEFAULT_MODEL_VERSION`.
