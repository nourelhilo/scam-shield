import pandas as pd
import pytest

from scamshield_ml.prepare import clean, near_duplicate_groups, split, validate_records


def rec(text, label, source="uci_sms", fraud=False, channel="sms", i=[0]):
    i[0] += 1
    return {"text": text, "label": label, "source": source, "source_label": "spam" if label else "ham",
            "fraud_specific": fraud, "channel": channel, "item_id": f"{source}:{i[0]}"}


def test_validate_rejects_bad_records():
    good = pd.DataFrame([rec("hello there friend", 0)])
    validate_records(good)
    with pytest.raises(ValueError):
        validate_records(good.assign(label=2))
    with pytest.raises(ValueError):
        validate_records(pd.concat([good, good]))
    with pytest.raises(ValueError):
        validate_records(good.assign(fraud_specific=True))  # fraud must be suspicious


def test_clean_dedupes_and_drops_conflicts_and_merges_fraud_flag():
    df = pd.DataFrame([
        rec("Win a prize now call 0800", 1),
        rec("WIN a prize now call 0801", 1, source="mendeley_smishing", fraud=True),  # identical after normalisation
        rec("see you at lunch today", 0),
        rec("see you at lunch today", 1),  # conflicting label
        rec("x", 0),  # too short
        rec("مرحبا كيف حالك", 0),  # Arabic: excluded from the English model
    ])
    out, drops = clean(df)
    assert len(out) == 1
    assert bool(out.iloc[0]["fraud_specific"]) is True
    assert out.iloc[0]["source"] == "mendeley_smishing"
    assert drops["conflicting_labels_for_identical_text"] == 2
    assert drops["exact_duplicate_removed"] == 1
    assert drops["language_ar"] == 1


def test_near_duplicates_share_a_group():
    texts = pd.Series([
        "your parcel is held pay the redelivery fee at urltoken today",
        "your parcel is held pay the redelivery fee at urltoken now",
        "lunch tomorrow at noon with the team",
        *[f"unrelated filler message number {w} about {w}s" for w in ["cats", "rain", "books", "trains", "jazz", "tea", "maps"]],
    ])
    g = near_duplicate_groups(texts, threshold=0.6)
    assert g[0] == g[1] and g[0] != g[2]
    assert len(set(g[2:])) == len(g) - 2


def test_split_keeps_groups_together_and_covers_all_partitions():
    rows = []
    for i in range(400):
        label = i % 2
        rows.append({**rec(f"msg {i}", label), "group": i // 2, "channel": "sms" if i % 4 < 2 else "email"})
    df = pd.DataFrame(rows)
    part = split(df)
    assert set(part) == {"train", "validation", "test"}
    assert (df.assign(p=part).groupby("group")["p"].nunique() == 1).all()
    assert 0.15 < (part == "test").mean() < 0.25
