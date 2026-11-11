from __future__ import annotations

import numpy as np
from sklearn.metrics import accuracy_score, brier_score_loss, confusion_matrix, precision_recall_fscore_support


def binary_report(y_true, y_pred) -> dict:
    y_true = np.asarray(y_true, dtype=int)
    y_pred = np.asarray(y_pred, dtype=int)
    cm = confusion_matrix(y_true, y_pred, labels=[0, 1])
    tn, fp, fn, tp = (int(v) for v in cm.ravel())
    p, r, f, s = precision_recall_fscore_support(y_true, y_pred, labels=[0, 1], zero_division=0)
    return {
        "n": int(len(y_true)),
        "accuracy": float(accuracy_score(y_true, y_pred)) if len(y_true) else None,
        "confusion_matrix": {"tn": tn, "fp": fp, "fn": fn, "tp": tp},
        "false_positive_rate": fp / (fp + tn) if (fp + tn) else None,
        "false_negative_rate": fn / (fn + tp) if (fn + tp) else None,
        "per_class": {
            "legitimate": {"precision": float(p[0]), "recall": float(r[0]), "f1": float(f[0]), "support": int(s[0])},
            "suspicious": {"precision": float(p[1]), "recall": float(r[1]), "f1": float(f[1]), "support": int(s[1])},
        },
        "macro_f1": float(np.mean(f)),
    }


def recall_only(y_true, y_pred) -> dict:
    """For subsets containing one class only (e.g. fraud-specific items, legitimate items)."""
    y_true = np.asarray(y_true, dtype=int)
    y_pred = np.asarray(y_pred, dtype=int)
    n = len(y_true)
    correct = int((y_true == y_pred).sum())
    return {"n": n, "correct": correct, "rate": correct / n if n else None}


def calibration(y_true, prob, bins: int = 10) -> dict:
    y_true = np.asarray(y_true, dtype=float)
    prob = np.asarray(prob, dtype=float)
    edges = np.linspace(0, 1, bins + 1)
    idx = np.clip(np.digitize(prob, edges[1:-1]), 0, bins - 1)
    table, ece = [], 0.0
    for b in range(bins):
        m = idx == b
        if not m.any():
            continue
        conf, acc = float(prob[m].mean()), float(y_true[m].mean())
        ece += m.mean() * abs(conf - acc)
        table.append({"bin": f"{edges[b]:.1f}-{edges[b + 1]:.1f}", "n": int(m.sum()), "mean_predicted": conf, "observed_suspicious_rate": acc})
    return {"brier": float(brier_score_loss(y_true, prob)), "ece_10_bins": float(ece), "reliability": table}
