"""Model text normalisation and feature analyzers.

THIS FILE IS A SPECIFICATION. server/ml/text-features.ts re-implements it exactly so the
Node.js backend can run inference without Python. Every regular expression below uses
explicit character classes (no \\w, \\s, \\b, or locale-aware lowercasing) so Python and
JavaScript behave identically. Parity is enforced by tests on both sides using
ml/artifacts/<version>/parity_fixtures.json. Bump NORMALIZER_VERSION on any change.
"""

from __future__ import annotations

import re
import unicodedata

NORMALIZER_VERSION = "norm-v1"
MAX_MODEL_CHARS = 10_000

_INVISIBLE = re.compile("[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff\u00ad]")
_LATIN_COMBINING = re.compile("[\u0300-\u036f]")
_ARABIC_DIACRITICS = re.compile("[\u064b-\u065f\u0670\u06d6-\u06ed]")
_TATWEEL = re.compile("\u0640")
_ALEF_VARIANTS = re.compile("[\u0622\u0623\u0625\u0671]")
_WHITESPACE = re.compile("[\t\n\u000b\u000c\r \u001c-\u001f\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+")
_EMAIL = re.compile("[a-z0-9._%+-]+@[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.[a-z]{2,24}")
_TLDS = (
    "com|net|org|info|biz|co|io|me|ly|us|uk|ca|au|in|de|fr|ru|cn|top|xyz|online|site|club|shop|"
    "store|app|link|live|click|vip|icu|cc|tk|ml|ga|cf|gq|pw|ws|su|buzz|win|loan|work|support|help"
)
_URL = re.compile(
    "(?:https?://|www\\.)[^ ]+"
    "|(?<![a-z0-9.-])[a-z0-9][a-z0-9-]*(?:\\.[a-z0-9-]+)*\\.(?:" + _TLDS + ")(?:/[^ ]*)?(?![a-z0-9-])"
)
_MONEY = re.compile("[$\u00a3\u20ac\u00a5\u20b9]")
_DIGIT = re.compile("[0-9]")
_NOT_ALLOWED = re.compile("[^a-z0-9!\u0621-\u064a ]")
_SPACES = re.compile(" +")
_WORD_TOKEN = re.compile("[a-z0-9\u0621-\u064a]+")


def _ascii_digits(value: str) -> str:
    out = []
    for ch in value:
        code = ord(ch)
        if 0x0660 <= code <= 0x0669:
            out.append(chr(48 + code - 0x0660))
        elif 0x06F0 <= code <= 0x06F9:
            out.append(chr(48 + code - 0x06F0))
        else:
            out.append(ch)
    return "".join(out)


def _ascii_lower(value: str) -> str:
    return "".join(chr(ord(c) + 32) if "A" <= c <= "Z" else c for c in value)


def normalize_for_model(text: str) -> str:
    """Canonical form the classifier sees. Deterministic and language-agnostic."""
    s = unicodedata.normalize("NFKC", text)
    s = _INVISIBLE.sub("", s)
    s = unicodedata.normalize("NFD", s)
    s = _LATIN_COMBINING.sub("", s)
    s = unicodedata.normalize("NFC", s)
    s = _ascii_digits(s)
    s = _ARABIC_DIACRITICS.sub("", s)
    s = _TATWEEL.sub("", s)
    s = _ALEF_VARIANTS.sub("\u0627", s)
    s = s.replace("\u0649", "\u064a").replace("\u0629", "\u0647")
    s = _ascii_lower(s)
    s = _WHITESPACE.sub(" ", s)
    s = _EMAIL.sub(" emailtoken ", s)
    s = _URL.sub(" urltoken ", s)
    s = _MONEY.sub(" moneytoken ", s)
    s = _DIGIT.sub("0", s)
    s = _NOT_ALLOWED.sub(" ", s)
    s = _SPACES.sub(" ", s).strip()
    return s[:MAX_MODEL_CHARS]


def word_tokens(normalized: str) -> list[str]:
    return _WORD_TOKEN.findall(normalized)


def word_ngrams(normalized: str, min_n: int = 1, max_n: int = 2) -> list[str]:
    tokens = word_tokens(normalized)
    grams: list[str] = []
    for n in range(min_n, max_n + 1):
        for i in range(0, len(tokens) - n + 1):
            grams.append(" ".join(tokens[i : i + n]))
    return grams


def char_ngrams(normalized: str, min_n: int = 3, max_n: int = 5) -> list[str]:
    """Character n-grams inside space-padded words (like scikit-learn's char_wb, minus its edge cases)."""
    grams: list[str] = []
    for token in normalized.split(" "):
        if not token:
            continue
        padded = " " + token + " "
        for n in range(min_n, max_n + 1):
            for i in range(0, len(padded) - n + 1):
                grams.append(padded[i : i + n])
    return grams


def detect_language(text: str) -> str:
    """Same rule as server/detection/normalize.ts detectLanguage."""
    arabic = sum(1 for c in text if "\u0600" <= c <= "\u06ff")
    latin = sum(1 for c in text if ("a" <= c <= "z") or ("A" <= c <= "Z"))
    total = arabic + latin
    if total < 3:
        return "unknown"
    ratio = arabic / total
    if ratio >= 0.8:
        return "ar"
    if ratio <= 0.2:
        return "en"
    return "mixed"


class WordAnalyzer:
    """Picklable callable analyzer for TfidfVectorizer/CountVectorizer."""

    def __init__(self, min_n: int = 1, max_n: int = 2):
        self.min_n, self.max_n = min_n, max_n

    def __call__(self, normalized: str) -> list[str]:
        return word_ngrams(normalized, self.min_n, self.max_n)

    def spec(self) -> dict:
        return {"kind": "word", "min_n": self.min_n, "max_n": self.max_n}


class CharAnalyzer:
    def __init__(self, min_n: int = 3, max_n: int = 5):
        self.min_n, self.max_n = min_n, max_n

    def __call__(self, normalized: str) -> list[str]:
        return char_ngrams(normalized, self.min_n, self.max_n)

    def spec(self) -> dict:
        return {"kind": "char", "min_n": self.min_n, "max_n": self.max_n}
