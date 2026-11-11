"""Checks on the COMMITTED model artifact (ml/artifacts/<version>)."""
import hashlib
import json
import os

import pytest

from scamshield_ml.linear_model import ReferenceModel
from scamshield_ml.paths import ARTIFACTS_DIR, PROCESSED_DIR
from scamshield_ml.text import normalize_for_model
from scamshield_ml.train import MODEL_VERSION

DIR = ARTIFACTS_DIR / MODEL_VERSION


def test_manifest_digest_matches_model():
    manifest = json.loads((DIR / "manifest.json").read_text())
    assert hashlib.sha256((DIR / "model.json").read_bytes()).hexdigest() == manifest["files"]["model.json"]
    assert manifest["model_version"] == MODEL_VERSION


def test_parity_fixtures_reproduce():
    ref = ReferenceModel.load(DIR / "model.json")
    fixtures = json.loads((DIR / "parity_fixtures.json").read_text())["fixtures"]
    for f in fixtures:
        assert normalize_for_model(f["text"]) == f["normalized"]
        assert abs(ref.predict_proba(f["text"]) - f["probability"]) < 1e-12


def test_metrics_describe_the_shipped_model():
    metrics = json.loads((DIR / "metrics.json").read_text())
    doc = json.loads((DIR / "model.json").read_text())
    assert metrics["model_sha256"] == hashlib.sha256((DIR / "model.json").read_bytes()).hexdigest()
    assert metrics["selected_family"] == doc["algorithm"]
    b = doc["bands"]
    assert 0 <= b["low_below"] <= b["elevated_from"] <= b["strong_from"] <= 1
    assert doc["supported_languages"] == ["en"]


@pytest.mark.skipif(os.environ.get("SCAMSHIELD_SLOW") != "1" or not (PROCESSED_DIR / "dataset.jsonl.gz").exists(),
                    reason="set SCAMSHIELD_SLOW=1 after preparing data to retrain and compare (~30 s)")
def test_training_is_reproducible(tmp_path):
    from scamshield_ml.train import run
    m = run(out_dir=tmp_path)
    assert m["model_sha256"] == json.loads((DIR / "manifest.json").read_text())["files"]["model.json"]
