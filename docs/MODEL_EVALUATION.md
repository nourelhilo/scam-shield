# Model Evaluation

All numbers below were **measured** by `npm run ml:train` and `npm run ml:evaluate-hybrid` on model `scamshield-text-v1.0.0` (SHA-256 `75cbf788…db17d`). Raw output: `ml/artifacts/scamshield-text-v1.0.0/metrics.json`, `hybrid_metrics.json`, `challenge_hybrid_results.json`.

> **Read this first.** The held-out test set comes from the **same public datasets** as the training data (different messages, with near-duplicates kept apart). These numbers measure how well the model separates *these* corpora. They are **not** an estimate of real-world accuracy on today's scams, and they should not be quoted as "ScamShield is 97% accurate". The hand-written challenge probes (section 6) show how much worse the model does outside this distribution.

## 1. Classifier on the held-out test set (2,946 messages, evaluated once)

Selected model: logistic regression, threshold 0.5.

| Metric | Value |
|---|---|
| Accuracy | 0.9773 |
| Precision (suspicious) | 0.9890 |
| Recall (suspicious) | 0.9517 |
| F1 (suspicious) | 0.9700 |
| Precision / recall / F1 (legitimate) | 0.9703 / 0.9934 / 0.9817 |
| Macro F1 | 0.9758 |
| False-positive rate | 0.66% (12 / 1,808) |
| False-negative rate | 4.83% (55 / 1,138) |

Confusion matrix (rows = truth):

| | predicted legitimate | predicted suspicious |
|---|---|---|
| **legitimate** | 1,796 | 12 |
| **suspicious** | 55 | 1,083 |

### Model families on test (for transparency; selection used validation only)

| Family (best on validation) | Accuracy | Precision | Recall | F1 | FPR | FNR |
|---|---|---|---|---|---|---|
| Logistic regression C=64 (**selected**) | 0.9773 | 0.9890 | 0.9517 | 0.9700 | 0.66% | 4.83% |
| Linear SVM C=4 | 0.9817 | 0.9901 | 0.9622 | 0.9759 | 0.61% | 3.78% |
| Multinomial NB α=0.01 | 0.9521 | 0.9339 | 0.9429 | 0.9383 | 4.20% | 5.71% |

The SVM was slightly better on test too. We did **not** switch to it after seeing test results: that would turn the test set into a selection set. See MODEL_TRAINING.md for why LR was chosen on validation.

## 2. Breakdown

| Subset (test) | n | Precision | Recall | F1 | FPR |
|---|---|---|---|---|---|
| SMS | 1,175 | 0.9657 | 0.9086 | 0.9363 | 0.61% |
| Email | 1,771 | 0.9935 | 0.9601 | 0.9765 | 0.73% |
| Source: Mendeley smishing set | 1,145 | 0.9693 | 0.9029 | 0.9349 | 0.52% |
| Source: Nazario phishing | 602 | 1.0000 | 0.9867 | 0.9933 | (no legitimate) |
| Source: SpamAssassin | 1,169 | 0.9816 | 0.9143 | 0.9467 | 0.73% |
| Source: UCI (after dedupe) | 30 | 0.9167 | 1.0000 | 0.9565 | 5.3% (1/19) |

| Subset | Correct / n | Rate |
|---|---|---|
| **Fraud-specific recall** (smishing + phishing) | 684 / 694 | 98.6% |
| Generic-spam recall | 399 / 444 | 89.9% |
| Legitimate SMS (`ham`) correctly legitimate | 983 / 989 | 99.4% |
| SpamAssassin `easy_ham` correctly legitimate | 775 / 775 | 100% |
| SpamAssassin **`hard_ham`** (spam-like legitimate mail) correctly legitimate | 38 / 44 | **86.4%** |

**By language:** English only. **Arabic and mixed-language results are not available.** There is no labelled real Arabic data (DATASET_SOURCES.md), so the model is not applied to Arabic or mixed text in production. The challenge probes (section 6) show the model's raw Arabic scores are meaningless: a legitimate Arabic OTP message scored 1.0.

## 3. Probability vs real-world confidence

The model outputs the probability that a text belongs to the "suspicious" class **as defined by these datasets**. This is not the probability that a message is a scam:

- Base rates differ. In the test set 39% of messages are suspicious; in a real inbox the share is very different. This alone changes what any score means.
- "Suspicious" includes generic spam, so a high score can mean "marketing-like", not "fraud".
- Out-of-distribution text (modern legitimate notifications, Arabic, new scam styles) can receive confident but wrong scores.

**Calibration on test.** Ten equal-width bins.

| Metric | Value |
|---|---|
| Brier score | 0.0170 |
| Expected calibration error (ECE) | 0.0132 |
| Platt scaling fitted on validation, evaluated on test | ECE 0.0076, Brier 0.0152 |

The scores are well calibrated in-distribution, except in the 0.2–0.5 range: 49 messages, where 64–71% are actually suspicious, so the model under-states risk there. Platt scaling would help slightly. It is **not** applied: the protocol fixed raw LR probabilities in advance, and the improvement was only measured on test. This is a candidate for the next version. The API never presents the score as a percentage chance of fraud; `mlPrediction.interpretation` says so explicitly.

### Bands on test

| Band | Messages | Share actually suspicious |
|---|---|---|
| low (< 0.20) | 1,802 | 1.2% |
| uncertain (0.20–0.50) | 49 | 69.4% |
| elevated (0.50–0.90) | 73 | 91.8% |
| strong (≥ 0.90) | 1,022 | 99.4% |

## 4. Hybrid detection on the test set

"Flagged" means the final risk level is MEDIUM or HIGH. The policy was chosen on **validation**.

| System | Precision | Recall | F1 | FPR | UNKNOWN |
|---|---|---|---|---|---|
| Rules only (previous behaviour) | 0.9027 | 0.1467 | 0.2525 | 1.00% | 12 |
| ML only (p ≥ 0.5) | 0.9890 | 0.9499 | 0.9691 | 0.66% | 13 |
| Hybrid: ML alone may not raise LOW | 0.9595 | 0.3954 | 0.5600 | 1.05% | 12 |
| **Hybrid, shipped** (ML alone may raise LOW→MEDIUM) | **0.9774** | **0.9104** | **0.9427** | **1.33%** | 12 |

Validation numbers for the same four systems, which were used to choose the policy:

| System (validation) | F1 | Recall | FPR |
|---|---|---|---|
| Rules only | 0.2562 | 0.148 | 0.55% |
| ML only | 0.9744 | 0.963 | 0.83% |
| ML alone may not raise | 0.5759 | 0.408 | 0.62% |
| Shipped policy | 0.9541 | 0.924 | 0.83% |

Observations:

- **The rules alone catch only 14.7% of these public-dataset scams and spam.** They were written for modern scam phrasing ("verify your account", "redelivery fee") and rarely fire on 2002–2015 spam or generic SMS spam (0% recall on SMS). The ML model is what makes the system useful on this distribution.
- **The hybrid has a higher false-positive rate than ML alone** (1.33% vs 0.66%) because it keeps rule findings the model disagrees with. Most of these come from emails: rules-only FPR is 2.2% on email, and 20% on SpamAssassin's `hard_ham`. A low ML score never lowers a rule finding, by design.
- **The hybrid has lower recall than ML alone** (0.910 vs 0.950) because an `elevated` score (0.5–0.9) without any rule indicator stays LOW. This is deliberate caution about moderate statistical scores.
- **Fraud-specific recall:** hybrid 97.0%, ML 98.4%, rules 18.4%. **Generic spam:** hybrid 81.8%, ML 89.6%, rules 8.8%.
- **The model alone never produces HIGH.** Of 1,138 suspicious test messages, 166 reached HIGH; each of those also had rule-based evidence.

## 5. Latency

| Measurement | Result |
|---|---|
| TypeScript inference, 10,000-character input | ~2.3 ms (unit test asserts < 50 ms) |
| Live server (worker thread, typical message) | 0.3–1.1 ms per request |
| Python reference, test messages | p50 0.07 ms, p95 0.17 ms |
| Model load | ~30 ms; worker pool ready in ~110 ms |
| Concurrency | 60 concurrent requests on 2 workers in tests; results identical to in-process |

## 6. Challenge probes (hand-written behaviour tests, not an accuracy estimate)

`ml/challenge/challenge_set.jsonl` contains 39 short messages written by the ScamShield team to probe specific behaviours. They are **not** training data and **not** a representative sample, so their percentages mean little. They are listed to show failure modes honestly.

Full-pipeline results (rules + ML + hybrid), from `challenge_hybrid_results.json`. ✅ = expected outcome; ❌ = wrong; ❔ = UNKNOWN.

| Category | Probes | Hybrid outcome |
|---|---|---|
| Short messages | 4 | 4 ✅ |
| Long messages | 2 | 2 ✅ |
| Misspellings | 3 | 2 ✅; ❌ "Congratulashions… clame" (p = 0.38, LOW) |
| Obfuscation | 3 | 1 ✅ (zero-width characters are removed by normalisation); ❌ "V-e-r-i-f-y b@nk acc0unt" (p = 0.69, no rule evidence → LOW); ❌ "FR33 iPh0ne w1nner" (p = 0.08) |
| URLs in text | 4 | 4 ✅ |
| **Legitimate security notifications** | 4 | **1 ✅; 3 ❌ → MEDIUM**: OTP code (p = 0.99), new sign-in alert (0.95), card purchase alert (0.98) |
| **Educational warnings** | 4 | **2 ✅; 2 ❌ → MEDIUM**: IT "we will never ask for your password" (ML 0.97); "prize messages… are scams" (rules MEDIUM, ML 0.25) |
| Modern fraud | 4 | 2 ✅; ❌ "Hi mum, new number, send 300" (p = 0.001); ❌ remote "liking videos" job (p = 0.82, no rule evidence → LOW) |
| Ordinary messages | 3 | 3 ✅ (two scored "elevated" by ML but stayed LOW) |
| Prompt-injection-like | 1 | 1 ✅ HIGH |
| Arabic (ML not applied) | 5 | 2 ✅ by rules; ❌ prize + card-number request (rules LOW); 2 legitimate → ❔ UNKNOWN |
| Mixed Arabic/English (ML not applied) | 2 | 1 ✅ HIGH; 1 legitimate → ❔ UNKNOWN |

English probes: hybrid correct on 22 / 32; rules-only would be correct on 23 / 32. The hybrid catches scams the rules miss (bit.ly account lock, misspelled parcel fee, Netflix billing domain). It adds false MEDIUM ratings on legitimate automated notifications and on one security-awareness message.

## 7. Failure analysis (test set)

Of the 30 largest test errors (`metrics.json` → `test_errors_top`):

- **Questionable source labels.** Several Mendeley `spam` items read as jokes or greetings ("did you hear about the new divorce barbie…", "how come it takes so little time for a child…"). The model scores them as legitimate. These may be label noise rather than model errors.
- **Conversational spam.** Dating and chat-style spam with no links or offers is missed.
- **Bank security advisories.** "Please protect yourself… bank never asks for… passwords… never share your password" scored 0.93–0.94 although it is labelled ham. This is the same failure as the probes: educational and security wording overlaps with phishing wording.
- **SpamAssassin `hard_ham`.** Legitimate newsletters and marketing are flagged (86.4% correct).
- **Short phishing emails** from Nazario with little text.

## 8. Reproducing

```sh
npm run ml:pipeline   # download -> prepare -> train -> evaluate-hybrid
npm run ml:test       # Python tests;  SCAMSHIELD_SLOW=1 also retrains and compares the hash
```
