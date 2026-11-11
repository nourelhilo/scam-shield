"""Shared feature space: word 1-2-grams + character 3-5-grams (inside words).

All candidate models see exactly the same vocabulary, fitted on the TRAIN partition only.
Logistic Regression and Linear SVM use sublinear TF-IDF with per-block L2 normalisation;
Multinomial Naive Bayes uses raw counts over the same vocabulary.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import scipy.sparse as sp
from sklearn.feature_extraction.text import TfidfVectorizer

from .text import CharAnalyzer, WordAnalyzer

WORD_CONFIG = {"min_n": 1, "max_n": 2, "min_df": 2, "max_features": 30_000}
CHAR_CONFIG = {"min_n": 3, "max_n": 5, "min_df": 3, "max_features": 50_000}


@dataclass
class FeatureSpace:
    word: TfidfVectorizer
    char: TfidfVectorizer
    word_counts: TfidfVectorizer
    char_counts: TfidfVectorizer

    def tfidf(self, normalized) -> sp.csr_matrix:
        return sp.hstack([self.word.transform(normalized), self.char.transform(normalized)], format="csr")

    def counts(self, normalized) -> sp.csr_matrix:
        return sp.hstack([self.word_counts.transform(normalized), self.char_counts.transform(normalized)], format="csr")

    @property
    def n_word(self) -> int:
        return len(self.word.vocabulary_)


def _tfidf(analyzer, cfg) -> TfidfVectorizer:
    return TfidfVectorizer(analyzer=analyzer, min_df=cfg["min_df"], max_features=cfg["max_features"], sublinear_tf=True, smooth_idf=True, norm="l2", dtype=np.float64)


def _with_vocab(analyzer, vocab) -> TfidfVectorizer:
    v = TfidfVectorizer(analyzer=analyzer, vocabulary=vocab, use_idf=False, norm=None, sublinear_tf=False, dtype=np.float64)
    return v.fit([""])


def fit_feature_space(train_normalized) -> FeatureSpace:
    wa = WordAnalyzer(WORD_CONFIG["min_n"], WORD_CONFIG["max_n"])
    ca = CharAnalyzer(CHAR_CONFIG["min_n"], CHAR_CONFIG["max_n"])
    word = _tfidf(wa, WORD_CONFIG).fit(train_normalized)
    char = _tfidf(ca, CHAR_CONFIG).fit(train_normalized)
    return FeatureSpace(word=word, char=char, word_counts=_with_vocab(wa, word.vocabulary_), char_counts=_with_vocab(ca, char.vocabulary_))
