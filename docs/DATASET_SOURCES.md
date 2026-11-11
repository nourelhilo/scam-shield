# Dataset Sources

ScamShield's classifier is trained only on public, labelled datasets whose provenance is recorded here. **No user submissions are used for training** (submissions are not stored, and no consent mechanism for training exists). No examples were invented to enlarge the data.

Raw files are **not committed**. `npm run ml:download` fetches each file from its original publisher and verifies a pinned SHA-256 digest (`ml/scamshield_ml/sources.py`). A file that does not match is deleted and the pipeline stops.

## Sources used

### 1. SMS Spam Collection (UCI Machine Learning Repository, id 228)

| | |
|---|---|
| Source | https://archive.ics.uci.edu/dataset/228/sms+spam+collection |
| Citation | Almeida, T. & Hidalgo, J. (2011). SMS Spam Collection. https://doi.org/10.24432/C5CC84 |
| Licence | CC BY 4.0 (redistribution permitted with attribution) |
| Records | 5,574 (4,827 `ham`, 747 `spam`) |
| Language | English |
| Labels | `ham` (legitimate), `spam` |
| Collection | Volunteered SMS (Grumbletext UK forum spam reports, NUS SMS Corpus, Caroline Tag's PhD corpus), around 2011–2012 |
| Limitations | 2011-era UK/Singapore SMS. "Spam" is generic unsolicited SMS (premium-rate prizes, marketing, adult services) - **not specifically fraud**. Ham is personal chat; it contains almost no legitimate automated notifications (OTP codes, bank alerts). Numbers in ham are anonymised as `&lt;#&gt;` (decoded during loading). |
| ScamShield mapping | `ham` → legitimate (0); `spam` → suspicious (1), `fraud_specific = false` |

### 2. SMS Phishing Dataset for Machine Learning and Pattern Recognition (Mendeley Data, v1)

| | |
|---|---|
| Source | https://data.mendeley.com/datasets/f45bkkt8pr/1 |
| Citation | Mishra, S. & Soni, D. (2022). https://doi.org/10.17632/f45bkkt8pr.1 |
| Licence | CC BY 4.0 (redistribution permitted with attribution) |
| Records | 5,971 (4,844 `ham`, 489 `spam`, 638 `Smishing`) |
| Language | English |
| Labels | `ham`, `spam`, `Smishing` (SMS phishing) |
| Collection | Built largely from the UCI collection plus additional smishing messages; per a 2026 systematic review, about 4,753 messages overlap with UCI |
| Limitations | Heavy overlap with UCI (handled by de-duplication). Some `spam` labels look questionable (e.g. jokes and greetings; see MODEL_EVALUATION.md error analysis). |
| ScamShield mapping | `ham` → 0; `spam` → 1, not fraud-specific; `Smishing` → 1, **`fraud_specific = true`** |

### 3. Nazario phishing corpus (monkey.org), yearly mailboxes 2015–2025

| | |
|---|---|
| Source | https://monkey.org/~jose/phishing/ (files `phishing-2015` … `phishing-2025`) |
| Licence | CC BY 4.0 (stated in the corpus `README.txt` and `LICENSE.txt`) |
| Records | 3,459 phishing emails across the 11 yearly mailboxes (mailbox-internal placeholder messages excluded) |
| Language | Mostly English |
| Labels | All phishing (hand-classified by the curator) |
| Collection | Phishing received in one researcher's personal inbox; described by the curator as representative, not exhaustive, and possibly containing classification errors |
| Limitations | One recipient's inbox (a single target profile). Later mailboxes are not anonymised; the recipient's name and domain (`jose`, `monkey.org`) are **removed during loading** so the model cannot learn them. No legitimate emails. |
| ScamShield mapping | → 1, **`fraud_specific = true`** |

### 4. Apache SpamAssassin public mail corpus

| | |
|---|---|
| Source | https://spamassassin.apache.org/old/publiccorpus/ (`20030228_easy_ham`, `_easy_ham_2`, `_hard_ham`, `_spam`, `20050311_spam_2`) |
| Licence | **No explicit licence.** Published for spam-filter research; the README states that copyright in message text remains with the original senders. **Not redistributed by ScamShield** (downloaded from Apache at training time; no email text is quoted in our reports). |
| Records | 6,046 (3,900 easy ham, 250 hard ham, 1,896 spam) |
| Language | Mostly English (non-English spam is excluded by the language filter) |
| Labels | `easy_ham`, `hard_ham` (legitimate mail that resembles spam), `spam` |
| Collection | Mailing-list and personal mail, 2002–2005 |
| Limitations | 2002-era mailing lists (technical, Linux/Irish user groups, RSS digests). Feed-digest `URL:`/`Date:` lines and mailing-list footers are removed during loading, but some list-specific vocabulary remains (see MODEL_LIMITATIONS.md). "Spam" is generic, not specifically fraud. |
| ScamShield mapping | ham → 0; spam → 1, not fraud-specific |

## Label definitions used by ScamShield

The classifier is **binary**:

- **suspicious (1)** = the source labelled the message spam, smishing, or phishing.
- **legitimate (0)** = the source labelled it ham.

`fraud_specific` marks the subset the source explicitly labelled as fraud (smishing or phishing). **Spam and scam are not the same category.** Generic spam (marketing, premium-rate offers) is labelled suspicious but is not fraud-specific. Metrics are therefore reported separately for the fraud-specific subset and the generic-spam subset (see MODEL_EVALUATION.md). The model is **not** validated as a fraud-only detector: it learned "unsolicited, spam-like, or phishing-like" versus "ordinary personal/mailing-list message".

## Considered and not used

| Dataset | Why not used |
|---|---|
| Enron-Spam (Metsis et al., 2006; CSV mirror under GPL-3.0) | No explicit licence on the original release; Enron ham is dominated by one company's internal vocabulary, a well-known shortcut for classifiers. |
| Arabic Scam and Legitimate Call Conversation Dataset ASLC-448 (Mendeley, CC BY 4.0) | **Simulated** phone-call dialogues (448), not real messages; different channel and format. Training on it would not support claims about Arabic SMS/email. |
| Multilingual SMS spam collections on Hugging Face (machine-translated, GPL or gated with synthetic data) | Arabic text is machine translation or synthetic, not real Arabic messages. |
| Smishtank smishing corpus (arXiv 2402.18430) | The dataset page (https://smishtank.com/dataset) returned 404 at the time of collection. |
| Kaggle phishing compilations | Require an account and click-through terms; they re-package the sources above with unclear licensing. |

**Result: no openly licensed corpus of real Arabic scam/spam messages was found.** The model is English-only, and the backend does not apply it to Arabic or mixed-language text (see ML_ARCHITECTURE.md).

## Preparation summary (seed 20261111)

| Step | Records |
|---|---|
| Raw records loaded | 21,050 |
| Dropped: fewer than 2 tokens after normalisation | 70 |
| Dropped: not English (`ar` 3, `unknown` 6) | 9 |
| Dropped: identical text with conflicting labels | 0 |
| Removed: exact duplicates after normalisation | 6,243 |
| **Final unique records** | **14,728** |
| Near-duplicate groups (cosine ≥ 0.80) | 12,868 (2,952 records belong to multi-member groups) |

| Partition | Total | Suspicious | Legitimate | Fraud-specific | SMS | Email |
|---|---|---|---|---|---|---|
| train | 9,425 | 3,641 | 5,784 | 2,218 | 3,761 | 5,664 |
| validation | 2,357 | 911 | 1,446 | 555 | 940 | 1,417 |
| test | 2,946 | 1,138 | 1,808 | 694 | 1,175 | 1,771 |

The partition fingerprint (SHA-256 over item ids and partitions) is `746a937a2748db1552937aed10d66f688f388c55e2e343d7d430ea30555ac864` and is recorded in `model.json`. Most UCI messages are counted under the Mendeley source after de-duplication, because Mendeley is the more specific source and wins on merge.
