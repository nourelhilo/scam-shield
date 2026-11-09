import { domainToUnicode } from "node:url";
import { parse as parseDomain } from "tldts";
import { BRANDS, RISKY_TLDS, URL_SHORTENERS, brandMentionedIn, deHomoglyph, isOfficialDomain, lookalikeBrand } from "./brands.ts";
import { clipEvidence } from "./normalize.ts";
import type { Indicator, IndicatorCategory, RuleDefinition, Severity } from "./types.ts";

/**
 * Static URL inspection. URLs are parsed with the WHATWG URL parser only:
 * they are NEVER fetched, resolved, or visited, so there is no SSRF surface here.
 * No indicators does not mean a URL is safe - only that none of these patterns matched.
 */
export const URL_RULES = {
  URL_UNSAFE_SCHEME: { category: "url_deception", severity: "high", description: "The link uses a scheme that can run code or open local files instead of a web page." },
  URL_EMBEDDED_CREDENTIALS: { category: "url_deception", severity: "high", description: "The link hides its real destination behind an '@' (text before '@' is ignored by browsers)." },
  URL_IP_HOST: { category: "url_structure", severity: "medium", description: "The link points to a raw IP address instead of a named website." },
  URL_PUNYCODE: { category: "url_deception", severity: "medium", description: "The domain uses encoded international characters (punycode), which can disguise look-alike names." },
  URL_MIXED_SCRIPT_DOMAIN: { category: "url_deception", severity: "high", description: "The domain mixes letters from different alphabets, a common way to imitate a real brand." },
  URL_BRAND_LOOKALIKE: { category: "url_deception", severity: "high", description: "The domain closely imitates a well-known brand but is not that brand's official domain." },
  URL_BRAND_IN_SUBDOMAIN: { category: "url_deception", severity: "high", description: "A well-known brand name appears in the subdomain, but the site actually belongs to a different domain." },
  URL_BRAND_MISMATCH: { category: "url_deception", severity: "medium", description: "The domain contains a well-known brand name but is not that brand's official domain." },
  URL_DOMAIN_IN_SUBDOMAIN: { category: "url_deception", severity: "medium", description: "The subdomain is shaped like another domain (for example 'secure.com.example.net'), which misleads readers." },
  URL_EXCESSIVE_SUBDOMAINS: { category: "url_structure", severity: "medium", description: "The link has an unusually deep chain of subdomains." },
  URL_UNUSUAL_CHARACTERS: { category: "url_structure", severity: "medium", description: "The link contains unusual encoded or control characters." },
  URL_REDIRECT_PARAMETER: { category: "url_lure", severity: "medium", description: "The link carries another web address in its parameters, which can be used to redirect you elsewhere." },
  URL_EMAIL_IN_PARAMETERS: { category: "url_lure", severity: "medium", description: "The link contains an email address, typical of personalised phishing links." },
  URL_SHORTENER: { category: "url_structure", severity: "low", description: "The link uses a URL shortener, which hides the real destination." },
  URL_RISKY_TLD: { category: "url_structure", severity: "low", description: "The domain ending is frequently used by short-lived or abusive sites." },
  URL_DECEPTIVE_DOMAIN_WORDS: { category: "url_lure", severity: "medium", description: "The domain name itself is built from words like 'verify', 'secure', or 'login', a common pattern in throwaway phishing domains." },
  URL_SENSITIVE_KEYWORDS: { category: "url_lure", severity: "low", description: "The link contains words like 'login' or 'verify', common in credential-phishing pages." },
  URL_EXCESSIVE_LENGTH: { category: "url_structure", severity: "low", description: "The link is unusually long, which can hide its real destination." },
  URL_MANY_HYPHENS: { category: "url_structure", severity: "low", description: "The domain contains many hyphens, common in throwaway look-alike domains." },
  URL_NON_STANDARD_PORT: { category: "url_structure", severity: "low", description: "The link uses a non-standard network port." },
  URL_NOT_HTTPS: { category: "url_structure", severity: "low", description: "The link does not use HTTPS. (HTTPS alone does not make a site trustworthy.)" },
} as const satisfies Record<string, { category: IndicatorCategory; severity: Severity; description: string }>;

export type UrlRuleId = keyof typeof URL_RULES;

export const URL_RULE_DEFINITIONS: RuleDefinition[] = Object.entries(URL_RULES).map(([id, r]) => ({
  id,
  category: r.category,
  severity: r.severity,
  description: r.description,
}));

export interface UrlAnalysis {
  input: string;
  valid: boolean;
  hostname: string | null;
  /** Unicode form of the hostname, for display. */
  displayHostname: string | null;
  registrableDomain: string | null;
  indicators: Indicator[];
}

const SENSITIVE_WORDS = /(?:^|[^a-z])(log-?in|sign-?in|verify|verification|validate|account|update|secure|security|password|banking|wallet|confirm|unlock|suspend(?:ed)?|billing|recover)(?:[^a-z]|$)/i;
const LURE_DOMAIN_WORDS = /(?:^|-)(login|signin|verify|verification|secure|security|account|update|confirm|unlock|support|helpdesk|refund|billing|wallet|alert|recovery)(?:-|$)/i;
const REDIRECT_PARAMS = /^(?:url|redirect|redirect_uri|redirect_url|return|returnurl|return_url|next|dest|destination|target|goto|continue|r|u|link)$/i;
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

function indicator(id: UrlRuleId, evidence: string): Indicator {
  const r = URL_RULES[id];
  return { code: id, category: r.category, severity: r.severity, description: r.description, evidence: clipEvidence(evidence, 160), source: "url" };
}

/** Parse user-supplied URL text. Adds http:// when no scheme is given ("example.com/path"). */
export function parseUserUrl(raw: string): URL | null {
  const value = raw.trim();
  if (!value || /\s/.test(value)) return null;
  try {
    return new URL(value);
  } catch {
    // fall through
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[^:]+:\d/.test(value)) return null;
  try {
    return new URL("http://" + value);
  } catch {
    return null;
  }
}

function hasMixedScripts(label: string) {
  const latin = /\p{Script=Latin}/u.test(label);
  const other = /[\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Armenian}]/u.test(label);
  return latin && other;
}

export function analyzeUrl(raw: string): UrlAnalysis {
  const url = parseUserUrl(raw);
  const out: UrlAnalysis = { input: raw, valid: false, hostname: null, displayHostname: null, registrableDomain: null, indicators: [] };
  if (!url) return out;
  out.valid = true;
  const found: Indicator[] = out.indicators;

  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  if (!["http", "https"].includes(scheme)) {
    found.push(indicator("URL_UNSAFE_SCHEME", `${scheme}:`));
    return out; // nothing else about javascript:/data: URLs is meaningful
  }
  if (scheme === "http") found.push(indicator("URL_NOT_HTTPS", "http://"));

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  out.hostname = hostname;
  out.displayHostname = domainToUnicode(hostname) || hostname;

  if (url.username || url.password) {
    found.push(indicator("URL_EMBEDDED_CREDENTIALS", `${decodeURIComponent(url.username)}${url.password ? ":…" : ""}@${hostname}`));
  }

  const info = parseDomain(hostname);
  if (info.isIp || /^\[.*\]$/.test(hostname)) {
    found.push(indicator("URL_IP_HOST", hostname));
  } else {
    const domain = info.domain ?? null;
    out.registrableDomain = domain;
    const labels = hostname.split(".");
    const subdomainLabels = info.subdomain ? info.subdomain.split(".").filter(Boolean) : [];
    const domainLabel = info.domainWithoutSuffix ?? labels[0] ?? "";

    // Internationalised names
    if (labels.some((l) => l.startsWith("xn--"))) {
      found.push(indicator("URL_PUNYCODE", `${hostname} → ${out.displayHostname}`));
      const unicodeLabels = (out.displayHostname ?? "").split(".");
      if (unicodeLabels.some(hasMixedScripts)) found.push(indicator("URL_MIXED_SCRIPT_DOMAIN", out.displayHostname ?? hostname));
    }

    // Brand impersonation
    const officialBrand = BRANDS.find((b) => isOfficialDomain(b, domain));
    if (!officialBrand) {
      const unicodeDomainLabel = deHomoglyph(domainToUnicode(domainLabel) || domainLabel);
      const lookalike = lookalikeBrand(unicodeDomainLabel) ?? lookalikeBrand(domainLabel);
      const subdomainBrand = subdomainLabels.length > 0 ? brandMentionedIn(subdomainLabels.join(".")) : null;
      const domainBrand = brandMentionedIn(unicodeDomainLabel);
      if (lookalike) {
        found.push(indicator("URL_BRAND_LOOKALIKE", `${out.displayHostname} (imitates ${lookalike.name})`));
      } else if (subdomainBrand) {
        found.push(indicator("URL_BRAND_IN_SUBDOMAIN", `${out.displayHostname} (mentions ${subdomainBrand.name}, but the site is ${domain ?? hostname})`));
      } else if (domainBrand) {
        found.push(indicator("URL_BRAND_MISMATCH", `${out.displayHostname} (mentions ${domainBrand.name})`));
      }
    }

    // Subdomain shaped like a domain: paypal.com.account-check.net
    if (subdomainLabels.some((l, i) => i < subdomainLabels.length - 1 && /^(com|net|org|gov|edu|co)$/.test(subdomainLabels[i + 1] ?? "") && l.length > 1)) {
      found.push(indicator("URL_DOMAIN_IN_SUBDOMAIN", hostname));
    }
    if (subdomainLabels.length >= 4) found.push(indicator("URL_EXCESSIVE_SUBDOMAINS", hostname));
    const unicodeLabel = domainToUnicode(domainLabel) || domainLabel;
    if ((unicodeLabel.match(/-/g) ?? []).length >= 3) found.push(indicator("URL_MANY_HYPHENS", domain ?? hostname));
    if (!officialBrand && unicodeLabel.includes("-")) {
      const lure = unicodeLabel.match(LURE_DOMAIN_WORDS);
      if (lure) found.push(indicator("URL_DECEPTIVE_DOMAIN_WORDS", domain ?? hostname));
    }
    if (info.publicSuffix && RISKY_TLDS.has(info.publicSuffix.split(".").pop() ?? "")) {
      found.push(indicator("URL_RISKY_TLD", `.${info.publicSuffix}`));
    }
    if (domain && URL_SHORTENERS.has(domain)) found.push(indicator("URL_SHORTENER", domain));

    // Sensitive words only count when the site is not an official brand domain.
    if (!officialBrand) {
      const target = `${info.subdomain ?? ""} ${domainLabel} ${url.pathname}`;
      const m = target.match(SENSITIVE_WORDS);
      if (m) found.push(indicator("URL_SENSITIVE_KEYWORDS", m[1] ?? m[0]));
    }
  }

  if (url.port && !["80", "443"].includes(url.port)) found.push(indicator("URL_NON_STANDARD_PORT", `:${url.port}`));

  const rest = url.pathname + url.search;
  const percentCount = (rest.match(/%[0-9a-f]{2}/gi) ?? []).length;
  if (/%0[0-9a-f]|%1[0-9a-f]|%7f/i.test(rest) || percentCount > 12 || /\\|\/\/{2,}|[<>]/.test(rest) || rest.includes("@")) {
    found.push(indicator("URL_UNUSUAL_CHARACTERS", clipEvidence(rest, 80)));
  }

  for (const [key, value] of url.searchParams) {
    if (REDIRECT_PARAMS.test(key) && /^(?:https?:)?\/\/|^https?%3a/i.test(value)) {
      found.push(indicator("URL_REDIRECT_PARAMETER", `${key}=${clipEvidence(value, 60)}`));
      break;
    }
  }
  if (EMAIL_PATTERN.test(decodeSafe(url.search))) found.push(indicator("URL_EMAIL_IN_PARAMETERS", "email address in query string"));

  if (raw.length > 120) found.push(indicator("URL_EXCESSIVE_LENGTH", `${raw.length} characters`));

  // De-duplicate by code (first wins).
  const seen = new Set<string>();
  out.indicators = found.filter((i) => (seen.has(i.code) ? false : (seen.add(i.code), true)));
  return out;
}

function decodeSafe(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Find web links inside free text. Bare domains ("parcel-help.top/pay") are included. */
export function extractUrls(text: string, limit = 10): string[] {
  const pattern = /\bhttps?:\/\/[^\s<>"'()]+|\bwww\.[^\s<>"'()]+|\b(?:[a-z0-9-]+\.)+[a-z]{2,24}\/[^\s<>"'()]*/gi;
  const urls: string[] = [];
  for (const m of text.matchAll(pattern)) {
    const cleaned = m[0].replace(/[.,;:!?]+$/, "");
    if (!urls.includes(cleaned)) urls.push(cleaned);
    if (urls.length >= limit) break;
  }
  return urls;
}
