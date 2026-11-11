# Model Limitations

These are measured or structural limits of `scamshield-text-v1.0.0`. Items marked **(show users)** should be visible in the product.

## What the model is and is not

- It is a **statistical text classifier** trained on public spam, smishing, and phishing datasets. It reports resemblance to those messages, **not proof** of fraud. **(show users)**
- It does **not** read images. Screenshots go through OCR, and only the extracted text is classified.
- It does **not** visit links, check sender authenticity (SPF/DKIM/DMARC), or know whether an organisation really sent a message. **(show users)**
- A low score is **not** evidence of safety. New scam styles may not resemble the training data. **(show users)**

## Known weaknesses (measured)

1. **English only.** No openly licensed real Arabic scam corpus was found. The model is not applied to Arabic or mixed-language text: those messages get the Arabic rule checks only, and UNKNOWN when the rules find nothing. **(show users: "Arabic messages are checked with rules only".)**
2. **False positives on legitimate automated notifications.** OTP codes, sign-in alerts, and card-purchase alerts scored 0.95–0.99 in probes and are rated **MEDIUM**. The public "legitimate" data is mostly personal chat and 2002-era mailing lists, with almost no transactional messages. **(show users: "Legitimate alerts from your bank or apps can be flagged; check in the official app".)**
3. **False positives on security-awareness messages.** "We will never ask for your password" style warnings resemble phishing wording (0.93–0.97).
4. **Old and narrow training data.** SMS from about 2011 (UK/Singapore), legitimate email from 2002–2005, phishing from one inbox (2015–2025). Modern formats are under-represented: delivery and toll smishing, WhatsApp "Hi mum" scams, crypto and job scams. The "Hi mum, new number" probe scored 0.001.
5. **Character tricks.** Heavy leetspeak ("FR33 iPh0ne w1nner") and letter spacing ("V-e-r-i-f-y") reduce scores. Zero-width characters and accents are normalised away.
6. **Dataset shortcuts remain.** Top weights include topical artefacts from specific sources: `heaven`, `usaa`, `export`, `subscribed`, `author`, and `i` (strongly legitimate, from personal chat). The cleanup in MODEL_TRAINING.md removed the worst ones, not all.
7. **"Suspicious" ≠ "scam".** Generic marketing spam is part of the suspicious class. Recall is 98.6% on fraud-specific test items and 89.9% on generic spam.
8. **Test metrics are in-distribution.** Test F1 0.970 does not transfer to real traffic. See MODEL_EVALUATION.md §6 for out-of-distribution behaviour.
9. **Scores in 0.2–0.5 under-state risk** (64–71% of those test items are suspicious). No calibration step is applied in v1.
10. **Selection margin.** Linear SVM was marginally better on both validation and test; LR was kept for probability output and exact explanations (MODEL_TRAINING.md).

## Explanation limits

- The listed words are those that moved the score most, **after normalisation**: lower-case, digits shown as `#`, links shown as `[link]`. They are not quotes of the original casing or spelling.
- Character n-gram credit is folded into whole words, so a word may be listed because of a sub-string pattern (for example `acc0unt` sharing `ccou` with "account").
- Common words like `your` and `click` carry large weight; their presence alone proves nothing.

## Hybrid design limits

- ML alone can raise LOW → MEDIUM (strong band), which causes limitation 2. It can never reach HIGH without rule evidence.
- A moderate ML score (0.5–0.9) without any rule indicator stays LOW. This misses some scams (the remote-job probe at 0.82).
- When the model cannot run and the rules find nothing, the result is UNKNOWN rather than LOW. Legitimate Arabic messages therefore show "Unknown risk".

## Operational limits

- The model loads from `ml/artifacts/`. If the files are missing or fail the checksum, the API keeps working with rules only and reports `mlPrediction.status: "unavailable"`. It never invents a prediction.
- Retraining requires network access to the dataset publishers and Python. Serving needs only Node.js.
- There is no feedback-to-training loop. Feedback is not ground truth, and user content is never used for training.
