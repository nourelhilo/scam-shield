import type { Language } from "./types.ts";

// Zero-width and bidi-control characters often used to slip past keyword filters.
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\u00AD]/g;
const ARABIC_DIACRITICS = /[\u064B-\u065F\u0670\u06D6-\u06ED]/g;
const TATWEEL = /\u0640/g;

export interface NormalizedText {
  /** Text used for matching: NFKC, invisible characters removed, Arabic letters unified. */
  text: string;
  invisibleCharCount: number;
  language: Language;
}

/** Map Arabic-Indic and Extended Arabic-Indic digits to ASCII digits. */
function asciiDigits(input: string) {
  return input.replace(/[\u0660-\u0669\u06F0-\u06F9]/g, (d) => {
    const code = d.charCodeAt(0);
    return String((code >= 0x06f0 ? code - 0x06f0 : code - 0x0660) % 10);
  });
}

/** Unify common Arabic spelling variants so a single pattern matches them all. */
export function normalizeArabic(input: string) {
  return input
    .replace(ARABIC_DIACRITICS, "")
    .replace(TATWEEL, "")
    .replace(/[\u0622\u0623\u0625\u0671]/g, "\u0627") // alef variants -> \u0627
    .replace(/\u0649/g, "\u064A") // alef maksura -> ya
    .replace(/\u0629/g, "\u0647"); // ta marbuta -> ha
}

export function detectLanguage(input: string): Language {
  const arabic = (input.match(/[\u0600-\u06FF]/g) ?? []).length;
  const latin = (input.match(/[A-Za-z]/g) ?? []).length;
  const total = arabic + latin;
  if (total < 3) return "unknown";
  const ratio = arabic / total;
  if (ratio >= 0.8) return "ar";
  if (ratio <= 0.2) return "en";
  return "mixed";
}

export function normalizeText(input: string): NormalizedText {
  const nfkc = input.normalize("NFKC");
  const invisibleCharCount = (nfkc.match(INVISIBLE) ?? []).length;
  const text = normalizeArabic(asciiDigits(nfkc.replace(INVISIBLE, "")));
  return { text, invisibleCharCount, language: detectLanguage(text) };
}

/** Collapse whitespace and clip an evidence excerpt to a safe display length. */
export function clipEvidence(value: string, max = 120) {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? collapsed.slice(0, max - 1) + "\u2026" : collapsed;
}
