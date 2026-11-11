# Model Training

## Requirements

- Python 3.12+ (the shipped model was trained with Python 3.14.3)
- About 70 MB of disk space for raw data
- Network access to the four publishers (see DATASET_SOURCES.md)

Pinned versions are in `ml/requirements.txt`: scikit-learn 1.9.1, scipy 1.18.1, numpy 2.5.4, pandas 3.1.1, pytest 9.2.0.

## Exact steps

```sh
npm run ml:setup            # creates ml/.venv and installs ml/requirements.txt
npm run ml:download         # downloads and SHA-256-verifies every source file into ml/data/raw/
npm run ml:prepare          # validate, normalise, dedupe, group near-duplicates, split -> ml/data/processed/
npm run ml:train            # train/compare/select/evaluate/export -> ml/artifacts/scamshield-text-v1.0.0/
npm run ml:evaluate-hybrid  # rules vs ML vs hybrid on validation and test -> hybrid_metrics.json
npm run ml:test             # Python unit tests
# or: npm run ml:pipeline   (download + prepare + train + evaluate-hybrid)
```

Training takes about 25 seconds on a laptop. **It is reproducible:** re-running prepare and train produced a byte-identical `model.json` (SHA-256 `75cbf7888475dd0a99bc60589f28fc3b69b4db7034ad7317be0da3c62fadb17d`). `SCAMSHIELD_SLOW=1 npm run ml:test` runs this check automatically.

Training is not a production build. It only writes the JSON model artifacts.

## Preprocessing decisions

| Decision | Reason |
|---|---|
| Emails become `subject + blank line + body`; headers are dropped | Matches what users paste and what the API sends to the model |
| HTML-only emails are converted to text (script/style removed) | Users see rendered text |
| RFC 2047 subjects are decoded | Undecoded `=?utf-8?…` strings became a spurious "spam" feature in the first run |
| Removed: recipient identity in Nazario (`jose`, `monkey.org`), mailing-list footers, feed `URL:`/`Date:` lines, `spamassassin.taint.org` | Source artefacts a model could memorise but users never submit |
| SMS HTML entities decoded (UCI's `&lt;#&gt;` placeholders) | Placeholder became a "legitimate" shortcut feature |
| Links, emails, currency symbols, and digits replaced by placeholders | Generalises across specific domains and numbers while keeping phishing signals ("there is a link", "a long number") |
| Only English (`detect_language == "en"`) kept | No real Arabic data; mixing in a handful of Arabic rows would not support Arabic claims |
| Fewer than 2 tokens dropped | Empty or corrupted after normalisation |
| Exact duplicates (after normalisation) collapsed; conflicting labels drop the whole group | Prevents train/test leakage and label noise |
| Near-duplicates (cosine ≥ 0.80 on word TF-IDF) grouped; groups never span partitions (StratifiedGroupKFold) | Campaign templates differing only in numbers or names cannot leak |
| Stratified by channel × label × fraud-specific | Every partition has SMS, email, spam, and fraud |
| 64 / 16 / 20 split (train / validation / test), seed 20261111 | |

The first training run exposed artefacts (`utf 0`, `url urltoken date`, `00t00`, `lt gt` among the top features). They were fixed in data preparation, found by inspecting **training-derived** feature weights, not test results. The metrics in MODEL_EVALUATION.md come from the run after these fixes.

## Model comparison protocol

The protocol was fixed in `train.py` before any results were seen:

1. Fit one shared feature space on **train only**: word 1–2-grams (min_df 2, 30k max) plus character 3–5-grams (min_df 3, 50k max).
2. Tune each family on **validation**:
   - Logistic regression (TF-IDF): C ∈ {0.25, 1, 4, 16, 64}
   - Linear SVM (TF-IDF): C ∈ {0.02, 0.05, 0.2, 1, 4}
   - Multinomial naive Bayes (raw counts, same vocabulary): α ∈ {0.01, 0.03, 0.1, 0.3, 1}
3. Select the best **validation** F1 for the suspicious class. Families within 0.005 of the best are preferred in this order: logistic regression (native probabilities, exact explanations) → naive Bayes → SVM.
4. Choose band thresholds on validation.
5. Evaluate **once** on test.

### Validation results (suspicious class, threshold 0.5)

| Family | Best params | Precision | Recall | F1 | FPR | Fit time |
|---|---|---|---|---|---|---|
| Logistic regression | C = 64 | 0.9865 | 0.9627 | 0.9744 | 0.83% | 0.56 s |
| Linear SVM | C = 4 | 0.9877 | 0.9704 | 0.9790 | 0.76% | 0.43 s |
| Multinomial NB | α = 0.01 | 0.9444 | 0.9517 | 0.9481 | 3.53% | 0.01 s |

**Selected: logistic regression, C = 64.** SVM led on validation by 0.0046 F1, which is inside the pre-declared 0.005 tolerance. LR was preferred because it outputs probabilities directly (an SVM needs a separate Platt calibration step) and because its per-feature explanations are exact. Inference cost is identical: both are one dot product over the same features. NB was clearly worse, mainly due to a 3.5% false-positive rate. C = 64 sits at the top of the grid; larger C was not explored.

Full grid: `ml/artifacts/scamshield-text-v1.0.0/metrics.json` → `comparison_validation`.

## Retraining

1. Add or replace sources in `sources.py` (pin SHA-256), with a loader in `data.py` and a licence entry in DATASET_SOURCES.md.
2. Bump `MODEL_VERSION` in `train.py`. Bump `NORMALIZER_VERSION` in **both** `text.py` and `text-features.ts` if normalisation changes.
3. Run `npm run ml:pipeline`, then review `metrics.json`, `hybrid_metrics.json`, and the challenge probes.
4. Point `DEFAULT_MODEL_VERSION` (`server/ml/model-path.ts`) at the new directory.
5. Run `npm run check` and `npm run ml:test`. The parity tests must pass.

Never train on user submissions without explicit, recorded consent.
