"""Portable linear text model: export to JSON and a reference (numpy-free) predictor.

The exported JSON is the ONLY artifact the backend loads. It is plain data (terms, IDF
values, weights, thresholds) - no pickle, no code - so loading it cannot execute anything.
`ReferenceModel` re-implements inference from the JSON in plain Python; server/ml/
implements the same algorithm in TypeScript. Both are checked against parity fixtures.
"""

from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path

from .text import MAX_MODEL_CHARS, NORMALIZER_VERSION, char_ngrams, normalize_for_model, word_ngrams

FORMAT = "scamshield-linear-text-model"
FORMAT_VERSION = 1


def _round(x: float) -> float:
    return float(f"{x:.9g}")


def build_block(kind: str, cfg: dict, vocabulary: dict[str, int], idf, weights, tfidf: bool) -> dict:
    terms = sorted(vocabulary, key=vocabulary.get)
    return {
        "kind": kind,
        "min_n": cfg["min_n"],
        "max_n": cfg["max_n"],
        "weighting": "sublinear_tfidf_l2" if tfidf else "raw_count",
        "terms": terms,
        "idf": [_round(float(idf[vocabulary[t]])) for t in terms] if tfidf else None,
        "weights": [_round(float(weights[vocabulary[t]])) for t in terms],
    }


def model_document(*, model_version: str, algorithm: str, blocks: list[dict], intercept: float, probability: dict, bands: dict, training: dict) -> dict:
    return {
        "format": FORMAT,
        "format_version": FORMAT_VERSION,
        "model_version": model_version,
        "algorithm": algorithm,
        "normalizer_version": NORMALIZER_VERSION,
        "max_chars": MAX_MODEL_CHARS,
        "supported_languages": ["en"],
        "positive_label": "suspicious",
        "intercept": _round(intercept),
        "probability": probability,
        "bands": bands,
        "training": training,
        "blocks": blocks,
    }


def write_model(doc: dict, out_dir: Path) -> str:
    out_dir.mkdir(parents=True, exist_ok=True)
    data = json.dumps(doc, ensure_ascii=False, separators=(",", ":"), sort_keys=False).encode("utf-8")
    (out_dir / "model.json").write_bytes(data)
    return hashlib.sha256(data).hexdigest()


class ReferenceModel:
    """Inference from the exported JSON document. Mirrors server/ml/linear-model.ts."""

    def __init__(self, doc: dict):
        if doc.get("format") != FORMAT or doc.get("format_version") != FORMAT_VERSION:
            raise ValueError("unsupported model format")
        if doc.get("normalizer_version") != NORMALIZER_VERSION:
            raise ValueError("normalizer version mismatch")
        self.doc = doc
        self.blocks = []
        for b in doc["blocks"]:
            index = {t: i for i, t in enumerate(b["terms"])}
            self.blocks.append((b, index))

    @classmethod
    def load(cls, path: Path) -> "ReferenceModel":
        return cls(json.loads(path.read_text("utf-8")))

    def _features(self, block: dict, normalized: str) -> list[str]:
        if block["kind"] == "word":
            return word_ngrams(normalized, block["min_n"], block["max_n"])
        return char_ngrams(normalized, block["min_n"], block["max_n"])

    def block_vectors(self, normalized: str):
        """Per block: {feature index: value} after the block's weighting."""
        out = []
        for block, index in self.blocks:
            counts: dict[int, int] = {}
            for g in self._features(block, normalized):
                j = index.get(g)
                if j is not None:
                    counts[j] = counts.get(j, 0) + 1
            if block["weighting"] == "sublinear_tfidf_l2":
                vals = {j: (1.0 + math.log(c)) * block["idf"][j] for j, c in counts.items()}
                norm = math.sqrt(sum(v * v for v in vals.values()))
                vals = {j: v / norm for j, v in vals.items()} if norm > 0 else {}
            else:
                vals = {j: float(c) for j, c in counts.items()}
            out.append((block, vals))
        return out

    def decision(self, text: str) -> float:
        normalized = normalize_for_model(text)
        score = self.doc["intercept"]
        for block, vals in self.block_vectors(normalized):
            w = block["weights"]
            score += sum(v * w[j] for j, v in vals.items())
        return score

    def probability_from_decision(self, score: float) -> float:
        p = self.doc["probability"]
        z = score if p["type"] == "logistic" else p["a"] * score + p["b"]
        return 1.0 / (1.0 + math.exp(-z)) if z >= 0 else math.exp(z) / (1.0 + math.exp(z))

    def predict_proba(self, text: str) -> float:
        return self.probability_from_decision(self.decision(text))
