from pathlib import Path

ML_DIR = Path(__file__).resolve().parent.parent
RAW_DIR = ML_DIR / "data" / "raw"
PROCESSED_DIR = ML_DIR / "data" / "processed"
ARTIFACTS_DIR = ML_DIR / "artifacts"
REPORTS_DIR = ML_DIR / "reports"
CHALLENGE_FILE = ML_DIR / "challenge" / "challenge_set.jsonl"
