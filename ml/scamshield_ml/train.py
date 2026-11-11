"""Train, compare, select, evaluate, and export the ScamShield text classifier.

Usage (from ml/):  python -I -m scamshield_ml.train

Protocol (fixed before any results were seen):
  1. Fit the shared feature space on TRAIN only.
  2. For each model family, tune hyperparameters on VALIDATION (grid below).
  3. Select the family with the best VALIDATION F1 for the suspicious class. A family within
     SELECTION_TOLERANCE of the best is preferred in this order: logistic regression
     (native probabilities, exact per-feature explanations), naive Bayes, linear SVM.
  4. Choose risk-band thresholds on VALIDATION.
  5. Evaluate the selected model ONCE on TEST. Test data is never used for any choice.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.naive_bayes import MultinomialNB
from sklearn.svm import LinearSVC

from . import MODEL_FAMILY
from .features import CHAR_CONFIG, WORD_CONFIG, FeatureSpace, fit_feature_space
from .linear_model import ReferenceModel, build_block, model_document, write_model
from .metrics import binary_report, calibration, recall_only
from .paths import ARTIFACTS_DIR, CHALLENGE_FILE, PROCESSED_DIR, REPORTS_DIR
from .prepare import SEED, load_prepared
from .text import detect_language, normalize_for_model

MODEL_VERSION = f"{MODEL_FAMILY}-v1.0.0"
SELECTION_TOLERANCE = 0.005
PREFERENCE = ["logistic_regression", "multinomial_nb", "linear_svm"]
GRIDS = {
    "logistic_regression": [{"C": c} for c in (0.25, 1.0, 4.0, 16.0, 64.0)],
    "linear_svm": [{"C": c} for c in (0.02, 0.05, 0.2, 1.0, 4.0)],
    "multinomial_nb": [{"alpha": a} for a in (0.01, 0.03, 0.1, 0.3, 1.0)],
}
# Band thresholds are chosen on validation to meet these targets.
STRONG_MIN_PRECISION = 0.98
LOW_MAX_SUSPICIOUS_RATE = 0.02
STRONG_FLOOR = 0.90
LOW_CEILING = 0.20


def make_model(family: str, params: dict):
    if family == "logistic_regression":
        return LogisticRegression(C=params["C"], solver="liblinear", max_iter=2000, random_state=SEED)
    if family == "linear_svm":
        return LinearSVC(C=params["C"], max_iter=20000, random_state=SEED)
    return MultinomialNB(alpha=params["alpha"])


def features_for(family: str, fs: FeatureSpace, normalized):
    return fs.counts(normalized) if family == "multinomial_nb" else fs.tfidf(normalized)


def decision_scores(family: str, model, X) -> np.ndarray:
    if family == "multinomial_nb":
        jll = model.predict_joint_log_proba(X) if hasattr(model, "predict_joint_log_proba") else model._joint_log_likelihood(X)
        return jll[:, 1] - jll[:, 0]
    return model.decision_function(X)


def linear_params(family: str, model) -> tuple[np.ndarray, float]:
    if family == "multinomial_nb":
        w = model.feature_log_prob_[1] - model.feature_log_prob_[0]
        b = model.class_log_prior_[1] - model.class_log_prior_[0]
        return w, float(b)
    return model.coef_.ravel(), float(model.intercept_[0])


def fit_platt(scores: np.ndarray, y: np.ndarray) -> dict:
    lr = LogisticRegression(C=1e6, solver="lbfgs", max_iter=1000).fit(scores.reshape(-1, 1), y)
    return {"type": "platt", "a": float(lr.coef_[0, 0]), "b": float(lr.intercept_[0]), "fitted_on": "validation"}


def to_probability(scores: np.ndarray, prob_spec: dict) -> np.ndarray:
    z = scores if prob_spec["type"] == "logistic" else prob_spec["a"] * scores + prob_spec["b"]
    return 1.0 / (1.0 + np.exp(-z))


def choose_bands(prob: np.ndarray, y: np.ndarray) -> dict:
    """Validation-derived thresholds, bounded by conservative policy floors.

    In-distribution validation precision overstates real-world precision (see the challenge
    probes in docs/MODEL_EVALUATION.md), so "strong" never starts below STRONG_FLOOR and
    "low" never extends above LOW_CEILING, whatever validation suggests.
    """
    grid = np.round(np.arange(0.50, 0.995, 0.01), 2)
    strong_val = next((float(t) for t in grid if (prob >= t).any() and y[prob >= t].mean() >= STRONG_MIN_PRECISION), 0.99)
    low_val = 0.0
    for t in np.round(np.arange(0.01, 0.50, 0.01), 2):
        m = prob < t
        if m.any() and y[m].mean() <= LOW_MAX_SUSPICIOUS_RATE:
            low_val = float(t)
    return {
        "low_below": min(low_val, LOW_CEILING),
        "elevated_from": 0.5,
        "strong_from": max(strong_val, STRONG_FLOOR),
        "validation_suggested": {"low_below": low_val, "strong_from": strong_val},
        "policy": {"strong_floor": STRONG_FLOOR, "low_ceiling": LOW_CEILING},
        "targets": {"strong_min_precision": STRONG_MIN_PRECISION, "low_max_suspicious_rate": LOW_MAX_SUSPICIOUS_RATE},
        "chosen_on": "validation",
    }


def band_of(p: float, bands: dict) -> str:
    if p >= bands["strong_from"]:
        return "strong"
    if p >= bands["elevated_from"]:
        return "elevated"
    if p < bands["low_below"]:
        return "low"
    return "uncertain"


def subgroup_reports(df, pred) -> dict:
    out = {}
    for name, mask in {
        "channel=sms": df["channel"] == "sms",
        "channel=email": df["channel"] == "email",
        **{f"source={s}": df["source"] == s for s in sorted(df["source"].unique())},
    }.items():
        out[name] = binary_report(df.loc[mask, "label"], pred[mask.to_numpy()])
    sus = df["label"] == 1
    out["recall:fraud_specific(smishing+phishing)"] = recall_only(df.loc[sus & df["fraud_specific"], "label"], pred[(sus & df["fraud_specific"]).to_numpy()])
    out["recall:generic_spam"] = recall_only(df.loc[sus & ~df["fraud_specific"], "label"], pred[(sus & ~df["fraud_specific"]).to_numpy()])
    for sl in ["ham", "easy_ham", "hard_ham"]:
        m = (df["label"] == 0) & (df["source_label"] == sl)
        if m.any():
            out[f"specificity:source_label={sl}"] = recall_only(df.loc[m, "label"], pred[m.to_numpy()])
    return out


def run(out_dir: Path | None = None) -> dict:
    df = load_prepared()
    tr, va, te = (df[df["partition"] == p].reset_index(drop=True) for p in ("train", "validation", "test"))
    fs = fit_feature_space(tr["normalized"])
    ytr, yva, yte = (d["label"].to_numpy() for d in (tr, va, te))

    comparison, best_by_family = [], {}
    for family, grid in GRIDS.items():
        Xtr, Xva = features_for(family, fs, tr["normalized"]), features_for(family, fs, va["normalized"])
        for params in grid:
            t0 = time.perf_counter()
            model = make_model(family, params).fit(Xtr, ytr)
            fit_s = time.perf_counter() - t0
            pred = (decision_scores(family, model, Xva) >= 0).astype(int)
            rep = binary_report(yva, pred)
            row = {"family": family, "params": params, "fit_seconds": round(fit_s, 2), "validation": rep}
            comparison.append(row)
            if family not in best_by_family or rep["per_class"]["suspicious"]["f1"] > best_by_family[family]["validation"]["per_class"]["suspicious"]["f1"]:
                best_by_family[family] = {**row, "model": model}

    best_f1 = max(b["validation"]["per_class"]["suspicious"]["f1"] for b in best_by_family.values())
    selected_family = next(f for f in PREFERENCE if best_by_family[f]["validation"]["per_class"]["suspicious"]["f1"] >= best_f1 - SELECTION_TOLERANCE)
    chosen = best_by_family[selected_family]
    model = chosen["model"]

    va_scores = decision_scores(selected_family, model, features_for(selected_family, fs, va["normalized"]))
    prob_spec = {"type": "logistic"} if selected_family == "logistic_regression" else fit_platt(va_scores, yva)
    va_prob = to_probability(va_scores, prob_spec)
    bands = choose_bands(va_prob, yva)

    # --- Held-out test: evaluated once, for the selected model and (for the comparison table) each family's best.
    test_by_family = {}
    for family, b in best_by_family.items():
        s = decision_scores(family, b["model"], features_for(family, fs, te["normalized"]))
        test_by_family[family] = binary_report(yte, (s >= 0).astype(int))

    te_scores = decision_scores(selected_family, model, features_for(selected_family, fs, te["normalized"]))
    te_prob = to_probability(te_scores, prob_spec)
    te_pred = (te_prob >= 0.5).astype(int)
    platt_check = fit_platt(va_scores, yva) if prob_spec["type"] == "logistic" else None

    # --- Export the portable model and verify the exported JSON reproduces sklearn exactly enough.
    w, b0 = linear_params(selected_family, model)
    tfidf = selected_family != "multinomial_nb"
    nw = fs.n_word
    blocks = [
        build_block("word", WORD_CONFIG, fs.word.vocabulary_, fs.word.idf_, w[:nw], tfidf),
        build_block("char", CHAR_CONFIG, fs.char.vocabulary_, fs.char.idf_, w[nw:], tfidf),
    ]
    summary = json.loads((PROCESSED_DIR / "dataset_summary.json").read_text())
    doc = model_document(
        model_version=MODEL_VERSION,
        algorithm=selected_family,
        blocks=blocks,
        intercept=b0,
        probability=prob_spec,
        bands=bands,
        training={
            "hyperparameters": chosen["params"],
            "train_records": int(len(tr)),
            "validation_records": int(len(va)),
            "test_records": int(len(te)),
            "seed": SEED,
            "partition_fingerprint_sha256": summary["partition_fingerprint_sha256"],
            "raw_sha256": summary["raw_sha256"],
            "sources": ["uci_sms", "mendeley_smishing", "spamassassin", "nazario"],
        },
    )
    out_dir = out_dir or (ARTIFACTS_DIR / MODEL_VERSION)
    model_sha = write_model(doc, out_dir)
    ref = ReferenceModel.load(out_dir / "model.json")

    sample = te.sample(n=min(400, len(te)), random_state=SEED)
    ref_prob = np.array([ref.predict_proba(t) for t in sample["text"]])
    sk_prob = to_probability(decision_scores(selected_family, model, features_for(selected_family, fs, sample["normalized"])), prob_spec)
    max_parity_err = float(np.max(np.abs(ref_prob - sk_prob)))
    if max_parity_err > 1e-5:
        raise RuntimeError(f"exported model disagrees with sklearn (max |dp| = {max_parity_err})")

    # --- Latency of the reference (pure-Python) implementation, single message at a time.
    lat = []
    for t in te["text"].iloc[:500]:
        t0 = time.perf_counter()
        ref.predict_proba(t)
        lat.append((time.perf_counter() - t0) * 1000)

    # --- Challenge probes (hand-written; behaviour checks only, not an accuracy estimate).
    probes = [json.loads(line) for line in CHALLENGE_FILE.read_text("utf-8").splitlines() if line.strip()]
    probe_rows = []
    for p in probes:
        prob = ref.predict_proba(p["text"])
        probe_rows.append({
            "id": p["id"], "category": p["category"], "language": detect_language(p["text"]),
            "expected": p["expected"], "probability": round(prob, 4), "band": band_of(prob, bands),
            "predicted": "suspicious" if prob >= 0.5 else "legitimate",
            "ml_applied_in_production": detect_language(p["text"]) == "en",
        })

    # --- Parity fixtures for the TypeScript implementation.
    # Dataset texts in committed fixtures come ONLY from the CC BY 4.0 SMS sources (UCI, Mendeley):
    # SpamAssassin email text is not redistributable, and Nazario mail may hold personal data.
    sms_fixture = te[(te["channel"] == "sms") & te["source"].isin(["uci_sms", "mendeley_smishing"])].sample(n=40, random_state=SEED)
    fixture_texts = list(sms_fixture["text"]) + [p["text"] for p in probes] + [
        "", "   ", "\u00c9COLE \uff26\uff55\uff4c\uff4c\uff57\uff49\uff44\uff54\uff48 \ufb01 ligature", "Visit HTTPS://Example.COM/Path?x=1 or www.test.io now!!!",
        "mail me: John.Doe+x@Mail.Example.co.uk", "\u0660\u0661\u0662 \u06f4\u06f5 \u0663\u0664 digits", "tab\tnew\nline\u00a0nbsp\u2003em",
        "emoji \U0001f600\U0001f389 and \U0001d401\U0001d428\U0001d425\U0001d41d math", "ZERO\u200bWIDTH\ufeffBOM\u00adSHY", "\u00a3100 \u20ac50 $20 \u00a55 \u20b99", "a", "x" * 50 + " " + "y" * 3,
        "Ali's \"quote\" \u2014 dash \u2013 and \u2026 ellipsis", "\u0130stanbul \u03a3\u039f\u03a6\u0399\u0391 stra\u00dfe", "\u0623\u064e\u0647\u0652\u0644\u0627\u064b \u0628\u0650\u0643\u064f\u0645 \u0640\u0640\u0640 \u0622\u0645\u0646\u0629 \u0625\u0644\u0649 \u0645\u0643\u062a\u0628\u0629", "short.ly/abc foo.top bar.example",
    ]
    fixtures = []
    for t in fixture_texts:
        fixtures.append({"text": t, "normalized": normalize_for_model(t), "decision": ref.decision(t), "probability": ref.predict_proba(t)})
    (out_dir / "parity_fixtures.json").write_text(json.dumps({"model_version": MODEL_VERSION, "fixtures": fixtures}, ensure_ascii=False, indent=1))

    # --- Error analysis material (identifiers + model-normalised snippets for SMS only).
    errors = []
    for i in np.argsort(-np.abs(te_prob - yte)):
        if len(errors) >= 30 or (te_prob[i] >= 0.5) == bool(yte[i]):
            break
        r = te.iloc[i]
        errors.append({
            "item_id": r["item_id"], "source": r["source"], "source_label": r["source_label"], "channel": r["channel"],
            "label": int(r["label"]), "probability": round(float(te_prob[i]), 4),
            "kind": "false_positive" if r["label"] == 0 else "false_negative",
            # Snippets only for CC BY 4.0 SMS sources; email text copyright stays with senders.
            "normalized_snippet": r["normalized"][:160] if r["channel"] == "sms" else None,
        })

    top_n = 25
    terms = blocks[0]["terms"]
    order = np.argsort(w[:nw])
    metrics = {
        "model_version": MODEL_VERSION,
        "model_sha256": model_sha,
        "selected_family": selected_family,
        "selected_params": chosen["params"],
        "selection_rule": f"best validation F1 (suspicious); ties within {SELECTION_TOLERANCE} prefer {PREFERENCE}",
        "comparison_validation": comparison,
        "comparison_test_best_per_family": {f: {"params": best_by_family[f]["params"], **r} for f, r in test_by_family.items()},
        "probability": prob_spec,
        "bands": bands,
        "test": binary_report(yte, te_pred),
        "test_subgroups": subgroup_reports(te, te_pred),
        "test_band_distribution": {
            band: {"n": int(m.sum()), "suspicious_rate": float(yte[m].mean()) if m.any() else None}
            for band in ["low", "uncertain", "elevated", "strong"]
            for m in [np.array([band_of(p, bands) == band for p in te_prob])]
        },
        "test_calibration": calibration(yte, te_prob),
        "test_calibration_if_platt_scaled": calibration(yte, to_probability(te_scores, platt_check)) if platt_check else None,
        "export_parity_max_abs_probability_error": max_parity_err,
        "latency_ms_reference_python": {"n": len(lat), "p50": float(np.percentile(lat, 50)), "p95": float(np.percentile(lat, 95)), "max": float(np.max(lat))},
        "challenge_probes": probe_rows,
        "test_errors_top": errors,
        "top_word_features": {
            "toward_suspicious": [(terms[j], round(float(w[j]), 3)) for j in order[::-1][:top_n]],
            "toward_legitimate": [(terms[j], round(float(w[j]), 3)) for j in order[:top_n]],
        },
        "vocabulary": {"word_terms": len(blocks[0]["terms"]), "char_terms": len(blocks[1]["terms"])},
    }
    (out_dir / "metrics.json").write_text(json.dumps(metrics, indent=1, ensure_ascii=False))
    manifest = {
        "model_version": MODEL_VERSION,
        "files": {"model.json": model_sha},
        "format": doc["format"],
        "format_version": doc["format_version"],
        "normalizer_version": doc["normalizer_version"],
        "trained_with": {"python": __import__("sys").version.split()[0], "scikit_learn": __import__("sklearn").__version__, "numpy": np.__version__},
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    return metrics


if __name__ == "__main__":
    m = run()
    print(json.dumps({k: m[k] for k in ["model_version", "model_sha256", "selected_family", "selected_params", "bands", "test", "export_parity_max_abs_probability_error", "latency_ms_reference_python"]}, indent=1))
