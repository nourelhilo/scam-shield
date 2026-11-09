import { parse as parseDomain } from "tldts";
import { BRANDS, FREE_MAIL_DOMAINS, brandMentionedIn, isOfficialDomain, lookalikeBrand, type Brand } from "./brands.ts";
import { clipEvidence } from "./normalize.ts";
import type { Indicator, RuleDefinition, Severity } from "./types.ts";

/**
 * Email analysis for pasted emails.
 *
 * IMPORTANT: pasted sender information is UNVERIFIED. Anyone can type any "From:" line.
 * We do not (and cannot) check SPF, DKIM, or DMARC because we never receive the original,
 * authenticated message headers. Sender checks here only look for inconsistencies in what
 * was pasted.
 */
export interface ParsedEmail {
  from: string | null;
  fromName: string | null;
  fromAddress: string | null;
  fromDomain: string | null;
  replyTo: string | null;
  replyToDomain: string | null;
  subject: string | null;
  body: string;
}

export interface StructuredEmail {
  from?: string | undefined;
  replyTo?: string | undefined;
  subject?: string | undefined;
  body?: string | undefined;
}

export const EMAIL_RULES = {
  EMAIL_SENDER_BRAND_MISMATCH: { severity: "high", description: "The sender name claims to be a well-known company, but the address is not from that company's domain." },
  EMAIL_LOOKALIKE_SENDER_DOMAIN: { severity: "high", description: "The sender's domain imitates a well-known brand." },
  EMAIL_DISPLAY_NAME_SPOOF: { severity: "medium", description: "The sender name contains a different email address than the one actually used." },
  EMAIL_FREE_MAIL_ORGANIZATION: { severity: "medium", description: "The sender claims to be an organisation but uses a free personal email service." },
  EMAIL_REPLY_TO_MISMATCH: { severity: "medium", description: "Replies would go to a different domain than the sender's." },
  EMAIL_LINK_DOMAIN_MISMATCH: { severity: "medium", description: "The email claims to be from a company, but its links point to unrelated domains." },
} as const satisfies Record<string, { severity: Severity; description: string }>;

export type EmailRuleId = keyof typeof EMAIL_RULES;

export const EMAIL_RULE_DEFINITIONS: RuleDefinition[] = Object.entries(EMAIL_RULES).map(([id, r]) => ({
  id,
  category: "sender",
  severity: r.severity,
  description: r.description,
}));

const ORG_WORDS = /\b(bank|support|security|billing|account(?:s)? team|service desk|helpdesk|customer service|administrator|admin team|it department|payroll|hr department|tax|government|police)\b|(البنك|الدعم|خدمة العملاء|الامن|الادارة)/i;

function domainOf(address: string | null) {
  if (!address) return null;
  const at = address.lastIndexOf("@");
  return at > 0 ? address.slice(at + 1).toLowerCase().replace(/[>\s]+$/, "") : null;
}

export function parseAddress(value: string): { name: string | null; address: string | null } {
  const trimmed = value.trim();
  const angle = trimmed.match(/^(.*?)<\s*([^<>\s]+@[^<>\s]+)\s*>\s*$/);
  if (angle) {
    const name = angle[1]!.trim().replace(/^["']|["']$/g, "").trim();
    return { name: name || null, address: angle[2]!.toLowerCase() };
  }
  const bare = trimmed.match(/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/);
  return bare ? { name: null, address: trimmed.toLowerCase() } : { name: trimmed || null, address: null };
}

/** Parse pasted email text: optional header lines at the top, a blank line, then the body. */
export function parseEmail(content: string, structured?: StructuredEmail): ParsedEmail {
  let from = structured?.from?.trim() || null;
  let replyTo = structured?.replyTo?.trim() || null;
  let subject = structured?.subject?.trim() || null;
  let body = structured?.body ?? "";

  if (!structured?.body) {
    const lines = content.replace(/\r\n/g, "\n").split("\n");
    let i = 0;
    for (; i < lines.length; i++) {
      const header = lines[i]!.match(/^(from|reply-to|subject|to|cc|date|sent)\s*:\s*(.*)$/i);
      if (!header) break;
      const key = header[1]!.toLowerCase();
      const value = header[2]!.trim();
      if (key === "from" && !from) from = value;
      else if (key === "reply-to" && !replyTo) replyTo = value;
      else if (key === "subject" && !subject) subject = value;
    }
    body = lines.slice(i).join("\n").trim();
  }

  const parsedFrom = from ? parseAddress(from) : { name: null, address: null };
  const parsedReply = replyTo ? parseAddress(replyTo) : { name: null, address: null };
  return {
    from,
    fromName: parsedFrom.name,
    fromAddress: parsedFrom.address,
    fromDomain: domainOf(parsedFrom.address),
    replyTo,
    replyToDomain: domainOf(parsedReply.address),
    subject,
    body,
  };
}

function indicator(id: EmailRuleId, evidence: string): Indicator {
  const r = EMAIL_RULES[id];
  return { code: id, category: "sender", severity: r.severity, description: r.description, evidence: clipEvidence(evidence), source: "email" };
}

const registrable = (domain: string | null) => (domain ? (parseDomain(domain).domain ?? domain) : null);

/** Sender-consistency checks. `linkDomains` are registrable domains of links in the body. */
export function analyzeEmailSender(email: ParsedEmail, linkDomains: string[]): Indicator[] {
  const out: Indicator[] = [];
  const senderDomain = registrable(email.fromDomain);

  // Which brand does the email claim to be from? Display name first, then the subject.
  const claimedBrand: Brand | null =
    (email.fromName ? brandMentionedIn(email.fromName) : null) ?? (email.subject ? brandMentionedIn(email.subject) : null);
  const senderIsOfficial = claimedBrand ? isOfficialDomain(claimedBrand, senderDomain) : false;

  if (email.fromName && claimedBrand && brandMentionedIn(email.fromName) && senderDomain && !senderIsOfficial) {
    out.push(indicator("EMAIL_SENDER_BRAND_MISMATCH", `${email.fromName} <${email.fromAddress}>`));
  }

  if (senderDomain && !BRANDS.some((b) => isOfficialDomain(b, senderDomain))) {
    const label = parseDomain(senderDomain).domainWithoutSuffix ?? senderDomain;
    const lookalike = lookalikeBrand(label);
    if (lookalike) out.push(indicator("EMAIL_LOOKALIKE_SENDER_DOMAIN", `${senderDomain} (imitates ${lookalike.name})`));
  }

  if (email.fromName && email.fromAddress) {
    const embedded = email.fromName.match(/[^\s@<>"']+@[^\s@<>"']+\.[a-z]{2,}/i);
    if (embedded && embedded[0].toLowerCase() !== email.fromAddress) {
      out.push(indicator("EMAIL_DISPLAY_NAME_SPOOF", `"${email.fromName}" <${email.fromAddress}>`));
    }
  }

  if (email.fromName && senderDomain && FREE_MAIL_DOMAINS.has(senderDomain) && (ORG_WORDS.test(email.fromName) || claimedBrand)) {
    // A brand whose own domain is a free-mail domain (e.g. Google/gmail.com) is not a mismatch.
    if (!senderIsOfficial) out.push(indicator("EMAIL_FREE_MAIL_ORGANIZATION", `${email.fromName} <${email.fromAddress}>`));
  }

  const replyDomain = registrable(email.replyToDomain);
  if (senderDomain && replyDomain && replyDomain !== senderDomain) {
    out.push(indicator("EMAIL_REPLY_TO_MISMATCH", `From ${senderDomain}, Reply-To ${replyDomain}`));
  }

  if (claimedBrand && linkDomains.length > 0) {
    const foreign = linkDomains.filter((d) => !isOfficialDomain(claimedBrand, d));
    if (foreign.length > 0) {
      out.push(indicator("EMAIL_LINK_DOMAIN_MISMATCH", `Claims ${claimedBrand.name}; links to ${foreign.slice(0, 3).join(", ")}`));
    }
  }

  return out;
}
