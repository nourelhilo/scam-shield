import type { Indicator, IndicatorCategory, InputType, RiskLevel } from "../detection/types.ts";

/** Plain-language labels for categories, used in explanations. */
const CATEGORY_PHRASES: Record<IndicatorCategory, string> = {
  pressure: "pressure to act quickly",
  credentials: "requests for passwords, codes, or personal details",
  financial: "requests for bank or card details",
  payment: "unusual payment demands",
  impersonation: "claims to be a trusted organisation",
  delivery: "a parcel-delivery problem",
  account: "a claim that your account has a problem",
  prize: "an unexpected prize or reward",
  investment: "promises of guaranteed returns",
  job: "a too-good-to-be-true job offer",
  phishing: "a push to click a link or log in",
  url_deception: "a link disguised to look like a trusted site",
  url_structure: "unusual link structure",
  url_lure: "a link designed to collect logins or redirect you",
  sender: "an inconsistent or disguised sender",
  obfuscation: "attempts to disguise the text",
  contextual: "contextual warning signs",
};

const NOUN: Record<InputType, string> = { text: "message", url: "link", email: "email" };

function listPhrases(categories: IndicatorCategory[]) {
  const phrases = [...new Set(categories)].slice(0, 3).map((c) => CATEGORY_PHRASES[c]);
  if (phrases.length <= 1) return phrases[0] ?? "";
  return phrases.slice(0, -1).join(", ") + " and " + phrases[phrases.length - 1];
}

/** Deterministic explanation built only from the final indicators - never from AI free text. */
export function buildExplanation(riskLevel: RiskLevel, indicators: Indicator[], inputType: InputType): string {
  const noun = NOUN[inputType];
  // Order categories by their strongest indicator so the explanation leads with what matters.
  const order = { high: 0, medium: 1, low: 2 } as const;
  const categories = [...indicators].sort((a, b) => order[a.severity] - order[b.severity]).map((i) => i.category);
  const phrases = listPhrases(categories);

  switch (riskLevel) {
    case "high":
      return `This ${noun} shows several strong warning signs that are common in scams, including ${phrases}. Treat it as likely fraudulent and do not act on it until you have verified it through an official channel you trust.`;
    case "medium":
      return `This ${noun} shows some warning signs that are common in scams, including ${phrases}. It may be legitimate, but be cautious and verify it independently before responding.`;
    case "low":
      return indicators.length > 0
        ? `We found a minor warning sign (${phrases}), but not enough on its own to suggest a scam. A low rating does not guarantee it is safe, so stay cautious.`
        : `We did not find common scam indicators in this ${noun}. That does not guarantee it is safe: new scams may not match known patterns, so verify anything unexpected.`;
    case "unknown":
    default:
      return `There is too little information to assess this ${noun}. Add more of the original content, or verify it directly with the sender through an official channel.`;
  }
}

/** Safety advice tailored to what was found. Always non-empty. */
export function buildRecommendations(riskLevel: RiskLevel, indicators: Indicator[], inputType: InputType): string[] {
  const cats = new Set(indicators.map((i) => i.category));
  const codes = new Set(indicators.map((i) => i.code));
  const recs: string[] = [];

  if (cats.has("credentials") || cats.has("financial")) {
    recs.push("Do not share passwords, one-time codes, or card or bank details. Legitimate organisations do not ask for these by message.");
    recs.push("If you already shared them, change your password, enable two-factor authentication, and contact your bank or provider right away.");
  }
  if (cats.has("payment")) recs.push("Do not send money, gift cards, or cryptocurrency. These payments are very hard to reverse.");
  if ([...cats].some((c) => c.startsWith("url_")) || cats.has("phishing") || inputType === "url") {
    recs.push(riskLevel === "low" ? "Before entering any information, check that the address bar shows the exact official domain." : "Do not open the link or enter information on the page it leads to.");
  }
  if (cats.has("delivery")) recs.push("Check delivery status only in the courier's or retailer's official app or website, by typing the address yourself.");
  if (cats.has("account") || cats.has("impersonation") || cats.has("sender")) {
    recs.push("Contact the organisation using a phone number or website you already trust, not the details in this " + (inputType === "email" ? "email." : "message."));
  }
  if (cats.has("prize") || cats.has("investment") || cats.has("job")) {
    recs.push("Be wary of offers that require an upfront fee or promise easy money. Research the company independently.");
  }
  if (codes.has("PROMPT_INJECTION_ATTEMPT")) recs.push("This text contains instructions aimed at automated checkers. Treat it with extra suspicion.");

  if (riskLevel === "high" || riskLevel === "medium") {
    recs.push("Report the message to the impersonated organisation or your local fraud-reporting service, then delete it.");
  }
  if (riskLevel === "low") recs.push("Stay cautious with unexpected requests, even when no warning signs are found.");
  if (riskLevel === "unknown") recs.push("If you are unsure, do not reply or click anything until you have verified the sender independently.");
  if (recs.length === 0) recs.push("Verify unexpected requests through an official channel you trust.");

  return [...new Set(recs)].slice(0, 6);
}
