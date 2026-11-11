from scamshield_ml.text import char_ngrams, detect_language, normalize_for_model, word_ngrams


def test_placeholders_for_links_emails_money_digits():
    assert normalize_for_model("Pay £50 at https://x.top/a?b=1 or mail a.b@c.co.uk by 9pm") == "pay moneytoken 00 at urltoken or mail emailtoken by 0pm"


def test_bare_domains_with_known_tlds_are_links():
    assert normalize_for_model("go to usps-track.com/abc now") == "go to urltoken now"
    assert normalize_for_model("e.g. this is fine") == "e g this is fine"


def test_zero_width_accents_and_ascii_lowercase():
    assert normalize_for_model("Pay​Pal ACCÖUNT") == "paypal account"


def test_arabic_variants_unify():
    assert normalize_for_model("أَحْمَد إلى مكتبة ٣٤") == normalize_for_model("احمد الي مكتبه 34")


def test_emoji_and_symbols_become_spaces():
    assert normalize_for_model("win \U0001f600\U0001f389 now!!") == "win now!!"


def test_length_cap():
    assert len(normalize_for_model("word " * 5000)) == 10_000


def test_ngrams():
    assert word_ngrams("verify your account") == ["verify", "your", "account", "verify your", "your account"]
    assert char_ngrams("ab", 3, 4) == [" ab", "ab ", " ab "]


def test_language_detection_matches_backend_rule():
    assert detect_language("hello there") == "en"
    assert detect_language("مرحبا بكم") == "ar"
    assert detect_language("مرحبا hello") == "mixed"
    assert detect_language("12 34") == "unknown"
