"""Loaders that turn each pinned raw source into a common record format.

Record columns:
  text            message text as a user would paste it (email = subject + body)
  label           1 = suspicious (spam, smishing, or phishing), 0 = legitimate
  source          source id (see sources.py)
  source_label    the label exactly as the source defined it (ham/spam/smishing/phishing...)
  fraud_specific  True only where the SOURCE labelled the item as phishing/smishing
                  (i.e. fraud). Generic spam is suspicious but NOT fraud_specific.
  channel         "sms" | "email"
  item_id         stable identifier within the source

Raw files are untrusted data: they are parsed as text only, never executed.
"""

from __future__ import annotations

import csv
import email
import email.policy
import html
import io
import mailbox
import re
import tarfile
import zipfile
from email.header import decode_header, make_header
from html.parser import HTMLParser
from pathlib import Path

import pandas as pd

from .paths import RAW_DIR
from .text import MAX_MODEL_CHARS

COLUMNS = ["text", "label", "source", "source_label", "fraud_specific", "channel", "item_id"]


# ---------------------------------------------------------------- SMS sources
def load_uci_sms(raw_dir: Path = RAW_DIR) -> pd.DataFrame:
    path = raw_dir / "uci_sms" / "smsspamcollection.zip"
    with zipfile.ZipFile(path) as zf:
        content = zf.read("SMSSpamCollection").decode("utf-8", errors="replace")
    rows = []
    for i, line in enumerate(content.splitlines()):
        if not line.strip():
            continue
        label, sep, text = line.partition("\t")
        if not sep:
            raise ValueError(f"uci_sms line {i}: missing tab separator")
        label = label.strip().lower()
        if label not in {"ham", "spam"}:
            raise ValueError(f"uci_sms line {i}: unexpected label {label!r}")
        rows.append(
            {"text": html.unescape(text), "label": int(label == "spam"), "source": "uci_sms", "source_label": label,
             "fraud_specific": False, "channel": "sms", "item_id": f"uci_sms:{i}"}
        )
    return pd.DataFrame(rows, columns=COLUMNS)


MENDELEY_LABELS = {"ham": (0, False), "spam": (1, False), "smishing": (1, True)}


def load_mendeley_smishing(raw_dir: Path = RAW_DIR) -> pd.DataFrame:
    path = raw_dir / "mendeley_smishing" / "Dataset_5971.zip"
    with zipfile.ZipFile(path) as zf:
        raw = zf.read("Dataset_5971.csv")
    # The file mixes UTF-8 with stray Windows-1252 bytes; decode leniently and record nothing else.
    reader = csv.DictReader(io.StringIO(raw.decode("utf-8", errors="replace")))
    rows = []
    for i, rec in enumerate(reader):
        label = (rec.get("LABEL") or "").strip().lower()
        if label not in MENDELEY_LABELS:
            raise ValueError(f"mendeley row {i}: unexpected label {label!r}")
        y, fraud = MENDELEY_LABELS[label]
        rows.append(
            {"text": html.unescape(rec.get("TEXT") or ""), "label": y, "source": "mendeley_smishing", "source_label": label,
             "fraud_specific": fraud, "channel": "sms", "item_id": f"mendeley:{i}"}
        )
    return pd.DataFrame(rows, columns=COLUMNS)


# -------------------------------------------------------------- email parsing
class _HtmlText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in {"script", "style", "head", "title"}:
            self._skip += 1
        elif tag in {"br", "p", "div", "tr", "li", "h1", "h2", "h3", "td"}:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in {"script", "style", "head", "title"} and self._skip:
            self._skip -= 1

    def handle_data(self, data):
        if not self._skip:
            self.parts.append(data)


def html_to_text(markup: str) -> str:
    parser = _HtmlText()
    try:
        parser.feed(markup)
        parser.close()
    except Exception:
        return html.unescape(re.sub(r"<[^>]+>", " ", markup))
    return "".join(parser.parts)


def _part_text(part) -> str:
    try:
        payload = part.get_payload(decode=True)
    except Exception:
        return ""
    if payload is None:
        return ""
    charset = part.get_content_charset() or "utf-8"
    try:
        return payload.decode(charset, errors="replace")
    except LookupError:
        return payload.decode("utf-8", errors="replace")


def email_text(msg) -> str:
    """Subject + readable body, the way a user would paste an email into ScamShield."""
    subject = decode_subject(msg.get("Subject", ""))
    plain, markup = [], []
    for part in msg.walk() if msg.is_multipart() else [msg]:
        if part.is_multipart() or part.get_content_disposition() == "attachment":
            continue
        ctype = part.get_content_type()
        if ctype == "text/plain":
            plain.append(_part_text(part))
        elif ctype == "text/html":
            markup.append(_part_text(part))
    body = "\n".join(plain) if any(p.strip() for p in plain) else "\n".join(html_to_text(m) for m in markup)
    return (subject + "\n\n" + body).strip()


def decode_subject(raw) -> str:
    """Decode RFC 2047 encoded words (=?utf-8?...?=) so they are not learned as tokens."""
    if not raw:
        return ""
    try:
        return str(make_header(decode_header(str(raw))))
    except Exception:
        return str(raw)


# Source artefacts that a model could memorise but no real user submission contains.
# Feed-digest lines ("URL: http://...", "Date: 2002-09-26T...") in SpamAssassin ham.
_FEED_LINES = re.compile(r"^(?:URL|Date):[^\n]*$", re.IGNORECASE | re.MULTILINE)
_LIST_FOOTER = re.compile(r"\n_{20,}\s*\n[\s\S]*?(mailing list|listinfo)[\s\S]*$", re.IGNORECASE)
_NAZARIO_RECIPIENT = re.compile(r"\b(jose|nazario|monkey\.org|monkey)\b", re.IGNORECASE)
_SA_TAINT = re.compile(r"spamassassin\.taint\.org", re.IGNORECASE)


def clean_email_artifacts(text: str, source: str) -> str:
    text = _LIST_FOOTER.sub("\n", text)
    text = _FEED_LINES.sub("", text)
    text = _SA_TAINT.sub("example.org", text)
    if source == "nazario":
        text = _NAZARIO_RECIPIENT.sub(" ", text)
    return text[:MAX_MODEL_CHARS]


def _parse_bytes(raw: bytes):
    return email.message_from_bytes(raw, policy=email.policy.compat32)


SPAMASSASSIN_ARCHIVES = {
    "20030228_easy_ham.tar.bz2": ("easy_ham", 0),
    "20030228_easy_ham_2.tar.bz2": ("easy_ham_2", 0),
    "20030228_hard_ham.tar.bz2": ("hard_ham", 0),
    "20030228_spam.tar.bz2": ("spam", 1),
    "20050311_spam_2.tar.bz2": ("spam_2", 1),
}


def load_spamassassin(raw_dir: Path = RAW_DIR) -> pd.DataFrame:
    rows = []
    for archive, (folder, y) in SPAMASSASSIN_ARCHIVES.items():
        with tarfile.open(raw_dir / "spamassassin" / archive, "r:bz2") as tf:
            for member in tf.getmembers():
                # Read regular files only, in memory; never extract to disk.
                if not member.isfile() or member.name.rsplit("/", 1)[-1] == "cmds" or member.size > 2_000_000:
                    continue
                handle = tf.extractfile(member)
                if handle is None:
                    continue
                msg = _parse_bytes(handle.read())
                text = clean_email_artifacts(email_text(msg), "spamassassin")
                rows.append(
                    {"text": text, "label": y, "source": "spamassassin", "source_label": folder.removesuffix("_2"),
                     "fraud_specific": False, "channel": "email", "item_id": f"spamassassin:{member.name}"}
                )
    return pd.DataFrame(rows, columns=COLUMNS)


def load_nazario(raw_dir: Path = RAW_DIR) -> pd.DataFrame:
    rows = []
    for path in sorted((raw_dir / "nazario").glob("phishing-*")):
        if path.suffix == ".part":
            continue
        box = mailbox.mbox(str(path), factory=lambda f: _parse_bytes(f.read()), create=False)
        for i, msg in enumerate(box):
            if msg is None or "FOLDER INTERNAL DATA" in str(msg.get("Subject", "")):
                continue
            text = clean_email_artifacts(email_text(msg), "nazario")
            rows.append(
                {"text": text, "label": 1, "source": "nazario", "source_label": "phishing",
                 "fraud_specific": True, "channel": "email", "item_id": f"nazario:{path.name}:{i}"}
            )
        box.close()
    return pd.DataFrame(rows, columns=COLUMNS)


LOADERS = {
    "uci_sms": load_uci_sms,
    "mendeley_smishing": load_mendeley_smishing,
    "spamassassin": load_spamassassin,
    "nazario": load_nazario,
}


def load_all(raw_dir: Path = RAW_DIR) -> pd.DataFrame:
    frames = [loader(raw_dir) for loader in LOADERS.values()]
    return pd.concat(frames, ignore_index=True)
