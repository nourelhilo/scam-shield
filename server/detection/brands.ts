/**
 * Frequently impersonated brands and their official registrable domains.
 * This list is intentionally small and conservative; it is used only to spot look-alikes,
 * never to declare a domain "safe".
 */
export interface Brand {
  name: string;
  /** Lowercase tokens that identify the brand in hostnames and display names. */
  tokens: string[];
  domains: string[];
}

export const BRANDS: Brand[] = [
  { name: "PayPal", tokens: ["paypal"], domains: ["paypal.com", "paypal.me"] },
  { name: "Apple", tokens: ["apple", "icloud", "itunes"], domains: ["apple.com", "icloud.com", "me.com"] },
  { name: "Microsoft", tokens: ["microsoft", "outlook", "office365", "hotmail"], domains: ["microsoft.com", "live.com", "outlook.com", "office.com", "hotmail.com", "microsoftonline.com"] },
  { name: "Google", tokens: ["google", "gmail"], domains: ["google.com", "gmail.com", "youtube.com", "goo.gl"] },
  { name: "Amazon", tokens: ["amazon"], domains: ["amazon.com", "amazon.co.uk", "amazon.ae", "amazon.sa", "amazon.eg", "amazon.de"] },
  { name: "Netflix", tokens: ["netflix"], domains: ["netflix.com"] },
  { name: "Facebook", tokens: ["facebook", "meta"], domains: ["facebook.com", "fb.com", "meta.com"] },
  { name: "Instagram", tokens: ["instagram"], domains: ["instagram.com"] },
  { name: "WhatsApp", tokens: ["whatsapp"], domains: ["whatsapp.com", "whatsapp.net", "wa.me"] },
  { name: "DHL", tokens: ["dhl"], domains: ["dhl.com", "dhl.de"] },
  { name: "FedEx", tokens: ["fedex"], domains: ["fedex.com"] },
  { name: "UPS", tokens: ["ups"], domains: ["ups.com"] },
  { name: "USPS", tokens: ["usps"], domains: ["usps.com"] },
  { name: "Aramex", tokens: ["aramex"], domains: ["aramex.com"] },
  { name: "Royal Mail", tokens: ["royalmail"], domains: ["royalmail.com"] },
  { name: "Binance", tokens: ["binance"], domains: ["binance.com"] },
  { name: "Coinbase", tokens: ["coinbase"], domains: ["coinbase.com"] },
];

export const FREE_MAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "yahoo.com", "ymail.com",
  "aol.com", "icloud.com", "me.com", "proton.me", "protonmail.com", "gmx.com", "gmx.de", "mail.com",
  "yandex.com", "yandex.ru", "mail.ru", "zoho.com",
]);

export const URL_SHORTENERS = new Set([
  "bit.ly", "tinyurl.com", "t.co", "goo.gl", "ow.ly", "is.gd", "buff.ly", "cutt.ly", "rebrand.ly",
  "shorturl.at", "rb.gy", "t.ly", "tiny.cc", "s.id", "lnkd.in",
]);

/** TLDs disproportionately used in abuse reports. A weak signal on its own. */
export const RISKY_TLDS = new Set([
  "zip", "mov", "xyz", "top", "tk", "ml", "ga", "cf", "gq", "click", "country", "kim", "work",
  "rest", "fit", "loan", "men", "support", "icu", "cam", "sbs", "cfd", "buzz", "monster",
]);

/** Undo common character substitutions used in look-alike domains (paypa1 -> paypal). */
export function deLeet(label: string) {
  return label
    .replace(/rn/g, "m")
    .replace(/vv/g, "w")
    .replace(/0/g, "o")
    .replace(/1/g, "l")
    .replace(/3/g, "e")
    .replace(/4/g, "a")
    .replace(/5/g, "s")
    .replace(/7/g, "t")
    .replace(/\$/g, "s");
}

/** Map common Cyrillic/Greek homoglyphs to Latin letters. */
export function deHomoglyph(value: string) {
  const map: Record<string, string> = {
    "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "у": "y", "х": "x", "і": "i", "ј": "j", "ѕ": "s",
    "ԁ": "d", "ɡ": "g", "һ": "h", "ӏ": "l", "ո": "n", "ν": "v", "ο": "o", "α": "a", "ρ": "p", "τ": "t",
  };
  return [...value].map((ch) => map[ch] ?? ch).join("");
}

/** Optimal string alignment distance (Damerau-Levenshtein with adjacent transpositions). */
export function editDistance(a: string, b: string) {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
    }
  }
  return d[a.length]![b.length]!;
}

export function isOfficialDomain(brand: Brand, registrableDomain: string | null) {
  return registrableDomain !== null && brand.domains.includes(registrableDomain);
}

/** Find a brand whose token appears as a hyphen/dot-delimited segment of a label (or inside a long label). */
export function brandMentionedIn(value: string): Brand | null {
  const lower = value.toLowerCase();
  const segments = lower.split(/[^a-z0-9]+/).filter(Boolean);
  for (const brand of BRANDS) {
    for (const token of brand.tokens) {
      if (segments.includes(token)) return brand;
      // Long tokens (5+) are distinctive enough to match inside a segment: "securepaypallogin".
      if (token.length >= 5 && segments.some((s) => s.includes(token))) return brand;
    }
  }
  return null;
}

/**
 * A hostname label that is a near-miss of a brand token: character substitution
 * (paypa1, micros0ft, rn->m), Cyrillic/Greek homoglyphs, or one edit away (paypall).
 * An exact brand segment ("paypal-secure") is a *mention*, handled by brandMentionedIn.
 */
export function lookalikeBrand(label: string): Brand | null {
  const segments = label.toLowerCase().split("-").filter(Boolean);
  for (const brand of BRANDS) {
    for (const token of brand.tokens) {
      if (token.length < 5) continue; // short tokens (ups, dhl, meta) give too many false positives
      for (const raw of segments) {
        if (raw === token) continue;
        const homoglyphFree = deHomoglyph(raw);
        if (homoglyphFree === token || deLeet(homoglyphFree) === token) return brand;
        // Edit distance only for distinctive tokens (6+ chars), so "apply" never matches "apple".
        if (token.length >= 6 && Math.abs(raw.length - token.length) <= 1 && editDistance(raw, token) === 1) return brand;
      }
    }
  }
  return null;
}
