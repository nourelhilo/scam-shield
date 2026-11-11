# ScamShield ML

ScamShield's own scam/phishing/spam text classifier: training pipeline (Python) and the trained model.

- `scamshield_ml/`: sources (pinned + SHA-256), download, loaders, normalisation spec, preparation, training, export
- `tests/`: pytest suite (`npm run ml:test`)
- `challenge/challenge_set.jsonl`: hand-written behaviour probes (not training data)
- `artifacts/scamshield-text-v1.0.0/`: the shipped model (`model.json`, plain JSON), `manifest.json` (SHA-256), metrics, parity fixtures
- `data/` (git-ignored): downloaded raw data and prepared splits

Quick start: `npm run ml:setup && npm run ml:pipeline`. The backend does not need Python; it loads `artifacts/` directly.

Docs: [ML architecture](../docs/ML_ARCHITECTURE.md) · [Datasets](../docs/DATASET_SOURCES.md) · [Training](../docs/MODEL_TRAINING.md) · [Evaluation](../docs/MODEL_EVALUATION.md) · [Limitations](../docs/MODEL_LIMITATIONS.md)
