"""Reproducible data preparation: validate -> normalise -> dedupe -> group near-duplicates -> split.

Usage (from ml/):  python -I -m scamshield_ml.prepare

Leakage control:
  * Exact duplicates (after model normalisation) are collapsed to one record. If copies
    disagree on the label (ham vs. suspicious) every copy is dropped.
  * Near-duplicates (cosine >= NEAR_DUP_THRESHOLD on word 1-2-gram TF-IDF) are joined into
    one group with union-find. A group never spans two partitions (StratifiedGroupKFold),
    so template variants of one campaign cannot sit in both train and test.
"""

from __future__ import annotations

import hashlib
import json
from collections import Counter

import numpy as np
import pandas as pd
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.model_selection import StratifiedGroupKFold

from .data import COLUMNS, load_all
from .download import sha256_file
from .paths import PROCESSED_DIR, RAW_DIR
from .sources import SOURCES
from .text import NORMALIZER_VERSION, detect_language, normalize_for_model, word_tokens

SEED = 20261111
NEAR_DUP_THRESHOLD = 0.80
MIN_TOKENS = 2
# More specific provenance wins when exact duplicates are merged.
SOURCE_PRIORITY = {"mendeley_smishing": 0, "nazario": 1, "uci_sms": 2, "spamassassin": 3}


class UnionFind:
    def __init__(self, n: int):
        self.parent = np.arange(n)

    def find(self, i: int) -> int:
        root = i
        while self.parent[root] != root:
            root = self.parent[root]
        while self.parent[i] != root:
            self.parent[i], i = root, self.parent[i]
        return int(root)

    def union(self, a: int, b: int) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[max(ra, rb)] = min(ra, rb)


def validate_records(df: pd.DataFrame) -> None:
    missing = set(COLUMNS) - set(df.columns)
    if missing:
        raise ValueError(f"missing columns: {sorted(missing)}")
    if df["item_id"].duplicated().any():
        raise ValueError("duplicate item_id values")
    if not df["label"].isin([0, 1]).all():
        raise ValueError("labels must be 0 or 1")
    if not df["channel"].isin(["sms", "email"]).all():
        raise ValueError("unknown channel")
    if (df["fraud_specific"] & (df["label"] == 0)).any():
        raise ValueError("fraud_specific records must be labelled suspicious")
    if df["text"].isna().any():
        raise ValueError("null text")


def clean(df: pd.DataFrame) -> tuple[pd.DataFrame, Counter]:
    """Normalise, drop unusable rows, and collapse exact duplicates. Returns (records, drop reasons)."""
    validate_records(df)
    drops: Counter = Counter()
    df = df.copy()
    df["normalized"] = df["text"].map(normalize_for_model)
    df["language"] = df["text"].map(detect_language)
    df["n_tokens"] = df["normalized"].map(lambda s: len(word_tokens(s)))

    too_short = df["n_tokens"] < MIN_TOKENS
    drops["empty_or_under_2_tokens_after_normalisation"] += int(too_short.sum())
    df = df[~too_short]

    non_english = df["language"] != "en"
    for lang, n in df.loc[non_english, "language"].value_counts().items():
        drops[f"language_{lang}"] += int(n)
    df = df[~non_english]

    df = df.assign(_prio=df["source"].map(SOURCE_PRIORITY)).sort_values(["_prio", "item_id"])
    kept = []
    for _, group in df.groupby("normalized", sort=False):
        if group["label"].nunique() > 1:
            drops["conflicting_labels_for_identical_text"] += len(group)
            continue
        first = group.iloc[0].to_dict()
        first["fraud_specific"] = bool(group["fraud_specific"].any())
        if first["fraud_specific"] and not group.iloc[0]["fraud_specific"]:
            first["source_label"] = group.loc[group["fraud_specific"], "source_label"].iloc[0]
        first["duplicate_count"] = len(group)
        first["all_sources"] = ",".join(sorted(set(group["source"])))
        drops["exact_duplicate_removed"] += len(group) - 1
        kept.append(first)
    out = pd.DataFrame(kept).drop(columns=["_prio"]).sort_values("item_id").reset_index(drop=True)
    return out, drops


def near_duplicate_groups(normalized: pd.Series, threshold: float = NEAR_DUP_THRESHOLD, chunk: int = 512) -> np.ndarray:
    capped = normalized.map(lambda s: s[:3000])
    vec = TfidfVectorizer(analyzer="word", token_pattern="[a-z0-9\u0621-\u064a]+", ngram_range=(1, 2), max_df=0.3, min_df=1, sublinear_tf=True, dtype=np.float32)
    X = vec.fit_transform(capped)
    uf = UnionFind(X.shape[0])
    XT = X.T.tocsr()
    for start in range(0, X.shape[0], chunk):
        sims = (X[start : start + chunk] @ XT).tocoo()
        mask = (sims.data >= threshold) & (sims.row + start < sims.col)
        for r, c in zip(sims.row[mask] + start, sims.col[mask]):
            uf.union(int(r), int(c))
    return np.array([uf.find(i) for i in range(X.shape[0])])


def split(df: pd.DataFrame, seed: int = SEED) -> pd.Series:
    strata = df["channel"] + "_" + df["label"].astype(str) + "_" + df["fraud_specific"].astype(str)
    outer = StratifiedGroupKFold(n_splits=5, shuffle=True, random_state=seed)
    trainval_idx, test_idx = next(outer.split(df, strata, df["group"]))
    part = pd.Series("train", index=df.index)
    part.iloc[test_idx] = "test"
    tv = df.iloc[trainval_idx]
    inner = StratifiedGroupKFold(n_splits=5, shuffle=True, random_state=seed + 1)
    _, val_rel = next(inner.split(tv, strata.iloc[trainval_idx], tv["group"]))
    part.iloc[trainval_idx[val_rel]] = "validation"
    return part


def raw_fingerprints() -> dict[str, str]:
    return {f"{s.id}/{f.filename}": sha256_file(RAW_DIR / s.id / f.filename) for s in SOURCES for f in s.files}


def prepare(write: bool = True) -> tuple[pd.DataFrame, dict]:
    raw = load_all()
    records, drops = clean(raw)
    records["group"] = near_duplicate_groups(records["normalized"])
    records["partition"] = split(records)

    # Hard leakage assertions.
    by_group = records.groupby("group")["partition"].nunique()
    assert (by_group == 1).all(), "a near-duplicate group spans partitions"
    assert not records["normalized"].duplicated().any(), "exact duplicates survived"

    summary = {
        "normalizer_version": NORMALIZER_VERSION,
        "seed": SEED,
        "near_duplicate_threshold": NEAR_DUP_THRESHOLD,
        "raw_records": int(len(raw)),
        "raw_records_by_source_label": {f"{k[0]}/{k[1]}": int(v) for k, v in raw.groupby(["source", "source_label"]).size().items()},
        "dropped": dict(sorted(drops.items())),
        "final_records": int(len(records)),
        "near_duplicate_groups": int(records["group"].nunique()),
        "records_in_multi_member_groups": int(records["group"].map(records["group"].value_counts()).gt(1).sum()),
        "partitions": {
            p: {
                "total": int(len(g)),
                "suspicious": int(g["label"].sum()),
                "legitimate": int((g["label"] == 0).sum()),
                "fraud_specific": int(g["fraud_specific"].sum()),
                "by_channel": {c: int(n) for c, n in g["channel"].value_counts().sort_index().items()},
                "by_source": {s: int(n) for s, n in g["source"].value_counts().sort_index().items()},
            }
            for p, g in records.groupby("partition")
        },
        "raw_sha256": raw_fingerprints(),
    }
    summary["partition_fingerprint_sha256"] = hashlib.sha256(
        "\n".join(records["item_id"] + "\t" + records["partition"]).encode()
    ).hexdigest()

    if write:
        PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
        cols = ["item_id", "source", "source_label", "fraud_specific", "channel", "language", "label", "group", "partition", "duplicate_count", "all_sources", "text", "normalized"]
        records[cols].to_json(PROCESSED_DIR / "dataset.jsonl.gz", orient="records", lines=True, force_ascii=False, compression="gzip")
        (PROCESSED_DIR / "dataset_summary.json").write_text(json.dumps(summary, indent=2))
    return records, summary


def load_prepared() -> pd.DataFrame:
    return pd.read_json(PROCESSED_DIR / "dataset.jsonl.gz", lines=True, compression="gzip", dtype={"item_id": str, "text": str, "normalized": str})


if __name__ == "__main__":
    _, s = prepare()
    print(json.dumps({k: v for k, v in s.items() if k != "raw_sha256"}, indent=2))
