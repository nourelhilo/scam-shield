import email.message
import io
import zipfile

import pandas as pd
import pytest

from scamshield_ml.data import (
    MENDELEY_LABELS, clean_email_artifacts, decode_subject, email_text, load_mendeley_smishing, load_uci_sms,
)


def _zip(path, name, content: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr(name, content)


def test_uci_labels_and_entity_decoding(tmp_path):
    _zip(tmp_path / "uci_sms" / "smsspamcollection.zip", "SMSSpamCollection", "ham\tI'll call &lt;#&gt; mins\nspam\tWIN cash now\n")
    df = load_uci_sms(tmp_path)
    assert df["label"].tolist() == [0, 1]
    assert df["source_label"].tolist() == ["ham", "spam"]
    assert not df["fraud_specific"].any()
    assert df["text"][0] == "I'll call <#> mins"


def test_uci_rejects_unknown_labels(tmp_path):
    _zip(tmp_path / "uci_sms" / "smsspamcollection.zip", "SMSSpamCollection", "maybe\tsomething\n")
    with pytest.raises(ValueError):
        load_uci_sms(tmp_path)


def test_mendeley_maps_smishing_as_fraud_specific(tmp_path):
    csv = "LABEL,TEXT,URL,EMAIL,PHONE\nham,hi there,No,No,No\nspam,cheap deals,No,No,No\nSmishing,verify your bank,Yes,No,No\n"
    _zip(tmp_path / "mendeley_smishing" / "Dataset_5971.zip", "Dataset_5971.csv", csv)
    df = load_mendeley_smishing(tmp_path)
    assert df["label"].tolist() == [0, 1, 1]
    assert df["fraud_specific"].tolist() == [False, False, True]
    assert set(MENDELEY_LABELS) == {"ham", "spam", "smishing"}


def test_email_text_prefers_plain_and_decodes_subject():
    msg = email.message.EmailMessage()
    msg["Subject"] = "=?utf-8?q?Caf=C3=A9_update?="
    msg.set_content("plain body")
    msg.add_alternative("<p>html body</p>", subtype="html")
    text = email_text(msg)
    assert text.startswith("Café update")
    assert "plain body" in text and "html body" not in text
    assert decode_subject("") == ""


def test_html_only_email_is_stripped():
    msg = email.message.EmailMessage()
    msg["Subject"] = "Hi"
    msg.set_content("<html><head><style>x{}</style></head><body>Click <b>here</b></body></html>", subtype="html")
    assert "Click here" in email_text(msg).replace("\n", "")
    assert "x{}" not in email_text(msg)


def test_artifact_cleaning_removes_source_identifiers():
    t = clean_email_artifacts("Dear jose, verify at monkey.org\nURL: http://feed/x\nDate: 2002-09-01T00:00\nbody\n" + "_" * 30 + "\nFoo mailing list\nhttp://list", "nazario")
    assert "jose" not in t and "monkey" not in t and "URL:" not in t and "mailing list" not in t
