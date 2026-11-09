import { analyzeEmailSender, parseEmail, type ParsedEmail, type StructuredEmail } from "./email-analyzer.ts";
import { normalizeText } from "./normalize.ts";
import { runObfuscationChecks, runTextRules } from "./text-rules.ts";
import type { Indicator, InputType, Language } from "./types.ts";
import { analyzeUrl, extractUrls, parseUserUrl } from "./url-analyzer.ts";

export interface DetectionInput {
  type: InputType;
  content: string;
  email?: StructuredEmail | undefined;
}

export interface DetectionResult {
  indicators: Indicator[];
  language: Language;
  insufficientContent: boolean;
  unanalyzable: boolean;
  /** The text the rules actually ran on (normalised). Used for the AI evidence check. */
  analysedText: string;
  urlsFound: number;
  email?: Pick<ParsedEmail, "fromAddress" | "fromDomain" | "subject"> & { senderVerified: false };
}

const MIN_WORDS = 3;
const MIN_CHARS = 12;

function isInsufficient(text: string) {
  const trimmed = text.trim();
  const words = trimmed.split(/\s+/).filter(Boolean).length;
  return trimmed.length < MIN_CHARS || words < MIN_WORDS;
}

function dedupe(indicators: Indicator[]) {
  const seen = new Set<string>();
  return indicators.filter((i) => (seen.has(i.code) ? false : (seen.add(i.code), true)));
}

/** URL indicators for every link in a piece of text (the strongest finding per code wins). */
function linkIndicators(text: string) {
  const urls = extractUrls(text);
  const domains: string[] = [];
  const indicators: Indicator[] = [];
  for (const raw of urls) {
    const analysis = analyzeUrl(raw);
    if (analysis.registrableDomain) domains.push(analysis.registrableDomain);
    else if (analysis.hostname) domains.push(analysis.hostname);
    indicators.push(...analysis.indicators);
  }
  // Inside a message, "not https" and long-URL signals are too weak to report.
  const filtered = indicators.filter((i) => i.code !== "URL_NOT_HTTPS" && i.code !== "URL_EXCESSIVE_LENGTH");
  return { urls, domains: [...new Set(domains)], indicators: filtered };
}

export function runDetection(input: DetectionInput): DetectionResult {
  if (input.type === "url") {
    const analysis = analyzeUrl(input.content);
    const text = normalizeText(input.content).text;
    return {
      indicators: analysis.indicators,
      language: "unknown",
      insufficientContent: false,
      unanalyzable: !analysis.valid,
      analysedText: text,
      urlsFound: analysis.valid ? 1 : 0,
    };
  }

  if (input.type === "email") {
    const parsed = parseEmail(input.content, input.email);
    const combined = [parsed.subject ?? "", parsed.body].filter(Boolean).join("\n");
    const norm = normalizeText(combined);
    const links = linkIndicators(norm.text);
    const senderIndicators = analyzeEmailSender(parsed, links.domains);
    const indicators = dedupe([
      ...runTextRules(norm.text),
      ...runObfuscationChecks(combined, norm.invisibleCharCount),
      ...links.indicators,
      ...senderIndicators,
    ]);
    return {
      indicators,
      language: norm.language,
      insufficientContent: isInsufficient(norm.text) && !parsed.fromAddress,
      unanalyzable: false,
      analysedText: [parsed.from ?? "", parsed.replyTo ?? "", norm.text].join("\n"),
      urlsFound: links.urls.length,
      email: { fromAddress: parsed.fromAddress, fromDomain: parsed.fromDomain, subject: parsed.subject, senderVerified: false },
    };
  }

  const norm = normalizeText(input.content);
  const links = linkIndicators(norm.text);
  const indicators = dedupe([
    ...runTextRules(norm.text),
    ...runObfuscationChecks(input.content, norm.invisibleCharCount),
    ...links.indicators,
  ]);
  return {
    indicators,
    language: norm.language,
    insufficientContent: isInsufficient(norm.text),
    unanalyzable: false,
    analysedText: norm.text,
    urlsFound: links.urls.length,
  };
}

/** True when a URL-type submission can be parsed as an address at all. */
export function isParsableUrl(value: string) {
  return parseUserUrl(value) !== null;
}
