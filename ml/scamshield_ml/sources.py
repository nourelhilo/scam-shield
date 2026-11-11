"""Pinned dataset sources.

Every file is downloaded from its original publisher and verified against a SHA-256
digest recorded here. Raw files are never committed (see .gitignore); run
`python -m scamshield_ml.download` to fetch them. See docs/DATASET_SOURCES.md.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class SourceFile:
    filename: str
    url: str
    sha256: str


@dataclass(frozen=True)
class Source:
    id: str
    name: str
    homepage: str
    license: str
    channel: str  # "sms" | "email"
    citation: str
    files: tuple[SourceFile, ...] = field(default_factory=tuple)


_SA = "https://spamassassin.apache.org/old/publiccorpus/"
_NZ = "https://monkey.org/~jose/phishing/"

_NAZARIO_SHA = {
    "2015": "7523e62a5e6e4ee8134ab8b1a628e423097a7779e1003b28422864aa34f1c319",
    "2016": "42393e4d686193bfb879d1608c23fd4d3b698ccd4d73f0e1d2276ba709718483",
    "2017": "110fba876b38b44035bf065788952674bc68a7b6879c345a515a9ac844b1d704",
    "2018": "83f49cf2a76c7b29b205d22d8778e46848e36af0f15ee1df126a543696acd48d",
    "2019": "cab39d6fcb38cf80cdaabb3e6ffd1222777e2fcaac7e8480321b7f729c2e3c0e",
    "2020": "99e20bf25f5e8556d37103f2c8140cd75181a62d3df91df8acf9d9aece9f08bb",
    "2021": "636707cff42245d1482e4ae8a2c03369717a5e06bf9d1a0f4ec5dcd846661cee",
    "2022": "a6291e2cb990204766fce425423949b403cce4ae6a660fc8d08812e40a063fa7",
    "2023": "5007f1c1dc91b15e93e988afa3a1cf402e15c88f765d3057be8bfec50dae1fe8",
    "2024": "60afa40a2757170093a2bde31ec9cda4e54d33992203ce04bfbbc86d2e5e5b99",
    "2025": "f1fa7e0fe35c9a16f36d9aa20ade7e1d3908d1d0c1d917b8c53c8aa799ec1c8f",
}

SOURCES: tuple[Source, ...] = (
    Source(
        id="uci_sms",
        name="SMS Spam Collection (UCI ML Repository, id 228)",
        homepage="https://archive.ics.uci.edu/dataset/228/sms+spam+collection",
        license="CC BY 4.0",
        channel="sms",
        citation="Almeida, T. & Hidalgo, J. (2011). SMS Spam Collection. UCI Machine Learning Repository. https://doi.org/10.24432/C5CC84",
        files=(
            SourceFile(
                "smsspamcollection.zip",
                "https://archive.ics.uci.edu/static/public/228/sms+spam+collection.zip",
                "1587ea43e58e82b14ff1f5425c88e17f8496bfcdb67a583dbff9eefaf9963ce3",
            ),
        ),
    ),
    Source(
        id="mendeley_smishing",
        name="SMS Phishing Dataset for Machine Learning and Pattern Recognition (Mendeley Data, v1)",
        homepage="https://data.mendeley.com/datasets/f45bkkt8pr/1",
        license="CC BY 4.0",
        channel="sms",
        citation="Mishra, S. & Soni, D. (2022). SMS Phishing Dataset for Machine Learning and Pattern Recognition. Mendeley Data, V1. https://doi.org/10.17632/f45bkkt8pr.1",
        files=(
            SourceFile(
                "Dataset_5971.zip",
                "https://data.mendeley.com/public-files/datasets/f45bkkt8pr/files/edb361de-918d-469f-9106-e84823830665/file_downloaded",
                "9bbf3188fdad81495d8e82825648b9b63b53fc86841a3d26c02629990b233cc3",
            ),
        ),
    ),
    Source(
        id="spamassassin",
        name="Apache SpamAssassin public mail corpus",
        homepage="https://spamassassin.apache.org/old/publiccorpus/",
        license="No explicit licence; published for spam-filter research. Copyright in message text remains with the original senders. Not redistributed by ScamShield.",
        channel="email",
        citation="Apache SpamAssassin Project. Public corpus (2002-2005). https://spamassassin.apache.org/old/publiccorpus/",
        files=(
            SourceFile("20030228_easy_ham.tar.bz2", _SA + "20030228_easy_ham.tar.bz2", "2b7b65904bcfcc31d2b5f51946f2d261370b257402cbbd62930b46ab83367438"),
            SourceFile("20030228_easy_ham_2.tar.bz2", _SA + "20030228_easy_ham_2.tar.bz2", "b4bd3dc5ae5b40f38e99a0e41ad7d16b428b56e818e3a6ffa07330d62004dd38"),
            SourceFile("20030228_hard_ham.tar.bz2", _SA + "20030228_hard_ham.tar.bz2", "ce2ce67880643dbde65ea7f85bffbfe4417349c4bd80b6b0de56262ae6b0a9c9"),
            SourceFile("20030228_spam.tar.bz2", _SA + "20030228_spam.tar.bz2", "c08debc32413804949a866be45ef78195cec2cbafd1da744ed76cdb860589743"),
            SourceFile("20050311_spam_2.tar.bz2", _SA + "20050311_spam_2.tar.bz2", "44280a0e28bf7645b2279e8e42659271ad82c6f40bf8d364dbda7f1df344a765"),
        ),
    ),
    Source(
        id="nazario",
        name="Nazario phishing corpus (monkey.org), yearly mailboxes 2015-2025",
        homepage="https://monkey.org/~jose/phishing/",
        license="CC BY 4.0 (stated in the corpus README.txt and LICENSE.txt)",
        channel="email",
        citation="Nazario, J. Phishing corpus. https://monkey.org/~jose/phishing/",
        files=tuple(SourceFile(f"phishing-{y}", f"{_NZ}phishing-{y}", sha) for y, sha in _NAZARIO_SHA.items()),
    ),
)


def source_by_id(source_id: str) -> Source:
    for s in SOURCES:
        if s.id == source_id:
            return s
    raise KeyError(source_id)
