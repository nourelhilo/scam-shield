/**
 * TypeScript port of ml/scamshield_ml/text.py (the specification).
 *
 * Every regular expression mirrors the Python version character for character and uses
 * explicit character classes, so both produce identical normalised text and n-grams.
 * Parity is tested against ml/artifacts/<version>/parity_fixtures.json.
 *
 * Erasable TypeScript only (no enums / parameter properties): this file is loaded by the
 * inference worker thread, which may run on Node's built-in type stripping.
 */
export const NORMALIZER_VERSION = "norm-v1";
export const MAX_MODEL_CHARS = 10_000;

const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\u00AD]/g;
const LATIN_COMBINING = /[\u0300-\u036F]/g;
const ARABIC_DIACRITICS = /[\u064B-\u065F\u0670\u06D6-\u06ED]/g;
const TATWEEL = /\u0640/g;
const ALEF_VARIANTS = /[\u0622\u0623\u0625\u0671]/g;
// Control characters are intentional: this is the exact whitespace set of the Python spec.
// eslint-disable-next-line no-control-regex
const WHITESPACE = /[\t\n\u000B\u000C\r \u001C-\u001F\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+/g;
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}/g;
const TLDS =
  "com|net|org|info|biz|co|io|me|ly|us|uk|ca|au|in|de|fr|ru|cn|top|xyz|online|site|club|shop|" +
  "store|app|link|live|click|vip|icu|cc|tk|ml|ga|cf|gq|pw|ws|su|buzz|win|loan|work|support|help";
const URL_RE = new RegExp(
  "(?:https?://|www\\.)[^ ]+" + "|(?<![a-z0-9.-])[a-z0-9][a-z0-9-]*(?:\\.[a-z0-9-]+)*\\.(?:" + TLDS + ")(?:/[^ ]*)?(?![a-z0-9-])",
  "g",
);
const MONEY = /[$\u00A3\u20AC\u00A5\u20B9]/g;
const DIGIT = /[0-9]/g;
const NOT_ALLOWED = /[^a-z0-9!\u0621-\u064A ]/g;
const SPACES = / +/g;
const WORD_TOKEN = /[a-z0-9\u0621-\u064A]+/g;

function asciiDigits(value: string): string {
  return value.replace(/[\u0660-\u0669\u06F0-\u06F9]/g, (d) => {
    const code = d.charCodeAt(0);
    return String.fromCharCode(48 + code - (code >= 0x06f0 ? 0x06f0 : 0x0660));
  });
}

/** Canonical form the classifier sees. Deterministic and language-agnostic. */
export function normalizeForModel(text: string): string {
  let s = text.normalize("NFKC");
  s = s.replace(INVISIBLE, "");
  s = s.normalize("NFD").replace(LATIN_COMBINING, "").normalize("NFC");
  s = asciiDigits(s);
  s = s.replace(ARABIC_DIACRITICS, "").replace(TATWEEL, "").replace(ALEF_VARIANTS, "\u0627");
  s = s.replace(/\u0649/g, "\u064A").replace(/\u0629/g, "\u0647");
  s = s.replace(/[A-Z]/g, (c) => c.toLowerCase());
  s = s.replace(WHITESPACE, " ");
  s = s.replace(EMAIL, " emailtoken ");
  s = s.replace(URL_RE, " urltoken ");
  s = s.replace(MONEY, " moneytoken ");
  s = s.replace(DIGIT, "0");
  s = s.replace(NOT_ALLOWED, " ");
  s = s.replace(SPACES, " ").trim();
  return s.slice(0, MAX_MODEL_CHARS);
}

export function wordTokens(normalized: string): string[] {
  return normalized.match(WORD_TOKEN) ?? [];
}

/** Word n-grams with the index of the first token of each n-gram. */
export function wordNgrams(normalized: string, minN: number, maxN: number): { gram: string; start: number; n: number }[] {
  const tokens = wordTokens(normalized);
  const out: { gram: string; start: number; n: number }[] = [];
  for (let n = minN; n <= maxN; n++) {
    for (let i = 0; i + n <= tokens.length; i++) out.push({ gram: tokens.slice(i, i + n).join(" "), start: i, n });
  }
  return out;
}

/** Character n-grams inside space-padded words, tagged with the index of their word piece. */
export function charNgrams(normalized: string, minN: number, maxN: number): { gram: string; piece: number }[] {
  const out: { gram: string; piece: number }[] = [];
  const pieces = normalized.split(" ");
  for (let p = 0; p < pieces.length; p++) {
    const token = pieces[p]!;
    if (!token) continue;
    const padded = " " + token + " ";
    for (let n = minN; n <= maxN; n++) {
      for (let i = 0; i + n <= padded.length; i++) out.push({ gram: padded.slice(i, i + n), piece: p });
    }
  }
  return out;
}
