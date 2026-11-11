import hashlib
import json

import numpy as np
import pytest
from sklearn.linear_model import LogisticRegression

from scamshield_ml.features import CHAR_CONFIG, WORD_CONFIG, fit_feature_space
from scamshield_ml.linear_model import ReferenceModel, build_block, model_document, write_model
from scamshield_ml.text import normalize_for_model

# A tiny UNIT-TEST corpus: exercises training/export mechanics only. It is never used to train
# or evaluate the shipped model.
CORPUS = [
    ("verify your account now at http://x.top", 1), ("you won a prize claim now", 1), ("urgent pay the fee today", 1),
    ("your bank account is locked confirm pin", 1), ("free gift card click here", 1), ("claim your reward now", 1),
    ("see you at lunch tomorrow", 0), ("can you send me the notes", 0), ("thanks for dinner last night", 0),
    ("meeting moved to three pm", 0), ("i will call you later", 0), ("happy birthday hope you enjoy it", 0),
]


def _train(seed=0):
    texts = [normalize_for_model(t) for t, _ in CORPUS]
    y = np.array([l for _, l in CORPUS])
    fs = fit_feature_space(texts)
    # min_df would empty the tiny vocabulary; refit with min_df=1 for this unit test.
    fs.word.set_params(min_df=1).fit(texts)
    fs.char.set_params(min_df=1).fit(texts)
    X = fs.tfidf(texts)
    clf = LogisticRegression(C=10, solver="liblinear", random_state=seed).fit(X, y)
    nw = len(fs.word.vocabulary_)
    w = clf.coef_.ravel()
    blocks = [
        build_block("word", WORD_CONFIG, fs.word.vocabulary_, fs.word.idf_, w[:nw], True),
        build_block("char", CHAR_CONFIG, fs.char.vocabulary_, fs.char.idf_, w[nw:], True),
    ]
    doc = model_document(model_version="unit-test-v0", algorithm="logistic_regression", blocks=blocks, intercept=float(clf.intercept_[0]),
                         probability={"type": "logistic"}, bands={"low_below": 0.2, "elevated_from": 0.5, "strong_from": 0.9}, training={})
    return fs, clf, doc


def test_exported_json_reproduces_sklearn(tmp_path):
    fs, clf, doc = _train()
    write_model(doc, tmp_path)
    ref = ReferenceModel.load(tmp_path / "model.json")
    probe = ["verify your prize now", "lunch at noon tomorrow", "", "totally unseen words"]
    sk = clf.predict_proba(fs.tfidf([normalize_for_model(t) for t in probe]))[:, 1]
    ours = np.array([ref.predict_proba(t) for t in probe])
    assert np.max(np.abs(sk - ours)) < 1e-6
    assert all(0.0 <= p <= 1.0 for p in ours)


def test_serialisation_is_deterministic(tmp_path):
    _, _, a = _train(seed=0)
    _, _, b = _train(seed=0)
    assert write_model(a, tmp_path / "a") == write_model(b, tmp_path / "b")


def test_artifact_is_plain_json(tmp_path):
    _, _, doc = _train()
    sha = write_model(doc, tmp_path)
    raw = (tmp_path / "model.json").read_bytes()
    assert hashlib.sha256(raw).hexdigest() == sha
    assert json.loads(raw)["format"] == "scamshield-linear-text-model"


def test_reference_model_rejects_foreign_formats():
    with pytest.raises(ValueError):
        ReferenceModel({"format": "pickle"})
    _, _, doc = _train()
    with pytest.raises(ValueError):
        ReferenceModel({**doc, "normalizer_version": "norm-v0"})
