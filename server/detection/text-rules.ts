import { clipEvidence, normalizeArabic } from "./normalize.ts";
import type { Indicator, IndicatorCategory, RuleDefinition, Severity } from "./types.ts";

/**
 * Rule-based detection for message text (used for text messages and email subject/body).
 *
 * Design notes:
 *  - Each rule is independent and returns at most one indicator with supporting evidence.
 *  - Rules for requests (passwords, codes, card numbers) require a request verb near the
 *    sensitive noun, and are suppressed by nearby negations ("we will never ask for your
 *    password") so legitimate security warnings are not flagged.
 *  - A single indicator never decides the outcome on its own; see risk/risk-engine.ts.
 *  - Arabic patterns are written in normalised form (see normalizeArabic) and are
 *    normalised again at load time so the source can use natural spelling.
 */
export interface TextRule extends RuleDefinition {
  patterns: RegExp[];
  /** Suppress a match when one of these appears shortly before it. */
  negations?: RegExp[];
}

const REQUEST_NEGATIONS = [
  /\b(never|not|don['’]?t|do not|will not|won['’]?t|no one|nobody)\b[^.!?\n]{0,40}$/i,
  /(لا|لن|ابدا|ابداً|ممنوع)[^.!؟\n]{0,30}$/,
];

const ar = (source: string) => new RegExp(normalizeArabic(source), "u");

const EN_REQUEST = String.raw`(?:enter|confirm|provide|send|share|reply with|give|submit|verify|update|type|tell us|tell me|text us|forward)`;

export const TEXT_RULES: TextRule[] = [
  {
    id: "URGENT_LANGUAGE",
    category: "pressure",
    severity: "medium",
    description: "The message pressures you to act quickly.",
    patterns: [
      /\b(?:act|respond|reply|verify|pay|confirm|update|call)\s+(?:now|immediately|right away|today|asap|urgently)\b/i,
      /\b(?:immediately|urgent(?:ly)?|asap|final (?:notice|warning|reminder)|last chance|expires? (?:today|tonight|soon))\b/i,
      /\b(?:within|in the next)\s+\d{1,3}\s*(?:minutes?|mins?|hours?|hrs?|h)\b/i,
      ar("(فورا|فوراً|على الفور|عاجل|في اسرع وقت|اخر فرصة|خلال \\d{1,3} (ساعة|ساعات|دقيقة|دقائق))"),
    ],
  },
  {
    id: "THREATENING_LANGUAGE",
    category: "pressure",
    severity: "medium",
    description: "The message threatens consequences such as account closure, fines, or legal action.",
    patterns: [
      /\b(?:legal action|lawsuit|arrest(?:ed)?|warrant|police|court|penalt(?:y|ies)|fined?)\b/i,
      /\b(?:will be|is going to be|has been)\s+(?:permanently\s+)?(?:closed|terminated|deleted|deactivated|suspended|blocked|locked)\b/i,
      ar("(اجراء قانوني|اجراءات قانونية|غرامة|القبض|سيتم (ايقاف|اغلاق|حظر|حذف|تجميد))"),
    ],
  },
  {
    id: "PASSWORD_REQUEST",
    category: "credentials",
    severity: "high",
    description: "The message asks for a password or login credentials.",
    patterns: [
      new RegExp(String.raw`\b${EN_REQUEST}\b[^.!?\n]{0,40}\b(?:password|passcode|pin(?: code)?|login (?:details|credentials)|credentials|username and password)\b`, "i"),
      /\b(?:your|the)\s+(?:password|passcode|login details)\s+(?:is required|must be (?:confirmed|verified|updated)|needs to be (?:confirmed|verified))\b/i,
      ar("(ارسل|ارسال|اكتب|كتابة|ادخل|ادخال|زودنا|تزويدنا|شارك|مشاركة|اعطنا|حدث|تاكيد|اكد)[^.!؟\\n]{0,30}(كلمة المرور|كلمة السر|الرقم السري)"),
    ],
    negations: REQUEST_NEGATIONS,
  },
  {
    id: "OTP_REQUEST",
    category: "credentials",
    severity: "high",
    description: "The message asks you to share a one-time or verification code.",
    patterns: [
      new RegExp(String.raw`\b${EN_REQUEST}\b[^.!?\n]{0,50}\b(?:otp|one[- ]time (?:pass(?:word|code)|code|pin)|verification code|security code|confirmation code|\d-digit code|code (?:we|you) (?:just )?(?:sent|received))\b`, "i"),
      /\b(?:read|tell)\s+(?:me|us)\s+the\s+code\b/i,
      ar("(ارسل|ارسال|اكتب|كتابة|ادخل|ادخال|زودنا|تزويدنا|شارك|مشاركة|اعطنا|اعد ارسال)[^.!؟\\n]{0,30}(رمز التحقق|كود التحقق|رمز التفعيل|الرمز المرسل|الكود المرسل|OTP)"),
    ],
    negations: REQUEST_NEGATIONS,
  },
  {
    id: "BANKING_INFO_REQUEST",
    category: "financial",
    severity: "high",
    description: "The message asks for bank account details.",
    patterns: [
      new RegExp(String.raw`\b${EN_REQUEST}\b[^.!?\n]{0,40}\b(?:bank (?:account|details|login)|account number|routing number|sort code|iban|online banking)\b`, "i"),
      ar("(ارسل|ارسال|اكتب|كتابة|ادخل|ادخال|زودنا|تزويدنا|شارك|مشاركة|اعطنا|حدث)[^.!؟\\n]{0,30}(رقم الحساب|الايبان|IBAN|بيانات حسابك البنكي|بيانات البنك)"),
    ],
    negations: REQUEST_NEGATIONS,
  },
  {
    id: "CARD_INFO_REQUEST",
    category: "financial",
    severity: "high",
    description: "The message asks for payment card details.",
    patterns: [
      new RegExp(String.raw`\b${EN_REQUEST}\b[^.!?\n]{0,40}\b(?:card (?:number|details)|credit card|debit card|cvv|cvc|security code on the back|expiry date)\b`, "i"),
      ar("(ارسل|ارسال|اكتب|كتابة|ادخل|ادخال|زودنا|تزويدنا|شارك|مشاركة|اعطنا|حدث)[^.!؟\\n]{0,30}(رقم البطاقة|بيانات البطاقة|CVV|الرمز السري للبطاقة|تاريخ انتهاء البطاقة)"),
    ],
    negations: REQUEST_NEGATIONS,
  },
  {
    id: "PERSONAL_INFO_REQUEST",
    category: "credentials",
    severity: "medium",
    description: "The message asks for identity information such as an ID or social security number.",
    patterns: [
      new RegExp(String.raw`\b${EN_REQUEST}\b[^.!?\n]{0,40}\b(?:social security|ssn|national id|passport (?:number|copy)|id (?:number|card)|date of birth|mother'?s maiden name)\b`, "i"),
      ar("(ارسل|ارسال|اكتب|كتابة|ادخل|ادخال|زودنا|تزويدنا|شارك|مشاركة|اعطنا)[^.!؟\\n]{0,30}(رقم الهوية|الهوية الوطنية|صورة الجواز|رقم الجواز|تاريخ الميلاد)"),
    ],
    negations: REQUEST_NEGATIONS,
  },
  {
    id: "PAYMENT_DEMAND",
    category: "payment",
    severity: "medium",
    description: "The message demands a payment or fee to release something or avoid a problem.",
    patterns: [
      /\b(?:pay|settle|clear)\b[^.!?\n]{0,30}\b(?:fee|fine|charge|balance|outstanding|customs|duty|redelivery)\b/i,
      /\b(?:small|outstanding|unpaid|release|processing|handling|redelivery|customs)\s+(?:fee|payment|charge|balance)\b/i,
      ar("(ادفع|سدد|دفع)[^.!؟\\n]{0,25}(رسوم|غرامة|مبلغ)|رسوم (التوصيل|الجمارك|الشحن|اعادة التوصيل)"),
    ],
  },
  {
    id: "UNUSUAL_PAYMENT_METHOD",
    category: "payment",
    severity: "high",
    description: "The message asks for payment by gift cards, cryptocurrency, or wire transfer, which are hard to reverse.",
    patterns: [
      /\b(?:gift ?cards?|itunes cards?|google play cards?|steam cards?|amazon cards?)\b/i,
      /\b(?:bitcoin|btc|usdt|crypto(?:currency)?|ethereum|wallet address)\b[^!?\n]{0,40}\b(?:send|pay|transfer|deposit)\b|\b(?:send|pay|transfer|deposit)\b[^!?\n]{0,40}\b(?:bitcoin|btc|usdt|crypto(?:currency)?|ethereum|wallet address)\b/i,
      /\b(?:western union|moneygram|wire transfer)\b/i,
      ar("(بطاقات? هدايا|بطاقة ايتونز|بيتكوين|عملات رقمية|عملة رقمية|USDT|ويسترن يونيون|حوالة)"),
    ],
  },
  {
    id: "IMPERSONATION",
    category: "impersonation",
    severity: "medium",
    description: "The message claims to come from a bank, government agency, or well-known company.",
    patterns: [
      /\b(?:this is|we are|from|on behalf of)\s+(?:the\s+|your\s+)?(?:bank|fraud (?:department|team)|security (?:team|department)|support team|customer (?:service|support)|tax (?:office|authority)|irs|hmrc|police|ministry|government)\b/i,
      /\b(?:paypal|apple|microsoft|amazon|netflix|google|facebook|instagram|whatsapp|dhl|fedex|ups|usps|aramex|royal mail)\s+(?:support|security|team|account|billing|customer service)\b/i,
      ar("(من البنك|خدمة العملاء|فريق الدعم|فريق الامن|ادارة الاحتيال|الشرطة|وزارة|هيئة الزكاة|البنك المركزي)"),
    ],
  },
  {
    id: "FAKE_DELIVERY",
    category: "delivery",
    severity: "medium",
    description: "The message is a delivery notice about a parcel being held or needing action.",
    patterns: [
      /\b(?:parcel|package|shipment|delivery|courier)\b[^.!?\n]{0,50}\b(?:on hold|held|pending|failed|unsuccessful|could not be delivered|undeliverable|awaiting (?:payment|confirmation)|returned)\b/i,
      /\b(?:reschedule|confirm)\s+(?:your\s+)?(?:delivery|address)\b/i,
      ar("(شحنتك|طردك|الشحنة|الطرد)[^.!؟\\n]{0,40}(معلق|متوقف|لم يتم|تعذر|بانتظار)|اعادة جدولة التوصيل|تاكيد العنوان"),
    ],
  },
  {
    id: "ACCOUNT_SUSPENSION",
    category: "account",
    severity: "medium",
    description: "The message claims your account is blocked, suspended, or limited.",
    patterns: [
      /\b(?:your\s+)?(?:account|card|profile|access|subscription)\b[^.!?\n]{0,30}\b(?:has been|was|is|will be)\s+(?:temporarily\s+|permanently\s+)?(?:blocked|suspended|locked|limited|restricted|disabled|deactivated|frozen|on hold)\b/i,
      /\bunusual (?:activity|sign[- ]in|login)\b/i,
      ar("(تم|سيتم)? ?(تعليق|ايقاف|تجميد|قفل|حظر) (حسابك|بطاقتك)|حسابك (معلق|موقوف|مجمد)|نشاط غير معتاد"),
    ],
  },
  {
    id: "PRIZE_LOTTERY",
    category: "prize",
    severity: "medium",
    description: "The message claims you have won a prize, lottery, or reward.",
    patterns: [
      /\b(?:you(?:'ve| have)?\s+(?:won|been selected)|congratulations[^.!?\n]{0,40}(?:won|winner|selected|prize|reward))\b/i,
      /\b(?:lottery|jackpot|prize (?:money|claim)|claim your (?:prize|reward|gift))\b/i,
      ar("(مبروك|تهانينا)[^.!؟\\n]{0,40}(ربحت|فزت|جائزة)|لقد (ربحت|فزت)|استلم جائزتك|اليانصيب"),
    ],
  },
  {
    id: "INVESTMENT_FRAUD",
    category: "investment",
    severity: "high",
    description: "The message promises guaranteed or unrealistic investment returns.",
    patterns: [
      /\b(?:guaranteed|risk[- ]free)\s+(?:returns?|profits?|income|income stream)\b/i,
      /\b(?:double|triple)\s+your\s+(?:money|investment|bitcoin|crypto)\b/i,
      /\b\d{2,4}\s*%\s*(?:daily|weekly|monthly)?\s*(?:returns?|profits?|roi)\b/i,
      ar("(ارباح|عائد|ربح) (مضمون|مضمونة)|ضاعف (اموالك|استثمارك)|استثمار بدون مخاطر"),
    ],
  },
  {
    id: "JOB_SCAM",
    category: "job",
    severity: "medium",
    description: "The message offers easy, high-paying work, often with an upfront fee or unusual hiring process.",
    patterns: [
      /\b(?:work from home|remote job|part[- ]time job|easy job)\b[^.!?\n]{0,60}(?:\$\s?\d+|\b\d+\s?(?:usd|dollars|aed|sar)\b|\bper (?:day|hour)\b|\bdaily\b)/i,
      /\b(?:earn|make)\s+(?:\$\s?\d+|\d+\s?(?:usd|dollars))\s*(?:\+\s*)?(?:a|per)\s+(?:day|hour)\b/i,
      /\b(?:registration|training|starter kit|onboarding)\s+fee\b/i,
      /\b(?:like|rate|review)\s+(?:videos|products|hotels)\s+(?:and|to)\s+(?:earn|get paid)\b/i,
      ar("(وظيفة|عمل) من المنزل|دخل يومي|ربح يومي|رسوم (تسجيل|تدريب)"),
    ],
  },
  {
    id: "PHISHING_CALL_TO_ACTION",
    category: "phishing",
    severity: "medium",
    description: "The message urges you to click a link or log in to fix a problem.",
    patterns: [
      /\b(?:click|tap|follow|open|visit)\s+(?:the|this|on the|on this|below)?\s*(?:link|button|url|here)\b[^.!?\n]{0,60}\b(?:verify|confirm|unlock|restore|update|secure|login|log in|sign in|claim|avoid)\b/i,
      /\b(?:verify|confirm|unlock|restore|update|secure|validate)\s+(?:your\s+)?(?:account|identity|details|information|payment)\b[^.!?\n]{0,40}\b(?:link|here|below|at)\b/i,
      ar("(اضغط|انقر|افتح|ادخل) (على )?(الرابط|هنا)"),
      ar("(عبر|من خلال|باستخدام) الرابط|(تحديث|تاكيد|تفعيل) (بياناتك|حسابك)"),
    ],
  },
  {
    id: "SECRECY_REQUEST",
    category: "pressure",
    severity: "medium",
    description: "The message asks you to keep it secret or not to contact anyone else.",
    patterns: [
      /\b(?:do not|don['’]t)\s+(?:tell|share this with|inform|contact)\s+(?:anyone|anybody|your bank|the bank|family|police)\b/i,
      /\b(?:keep this|this is)\s+(?:confidential|secret|between us)\b/i,
      ar("(لا تخبر|لا تبلغ) (احدا|احد|البنك)|سري للغاية"),
    ],
  },
  {
    id: "PROMPT_INJECTION_ATTEMPT",
    category: "obfuscation",
    severity: "low",
    description: "The text contains instructions aimed at automated scanners, which is unusual in genuine messages.",
    patterns: [
      /\b(?:ignore|disregard|forget)\s+(?:all\s+|any\s+)?(?:previous|prior|above|earlier)\s+(?:instructions|prompts|rules)\b/i,
      /\b(?:you are (?:now )?an? (?:ai|assistant|language model)|system prompt|classify this (?:message|email) as (?:safe|legitimate|low risk))\b/i,
      /\b(?:this|the) (?:message|email|link) is (?:safe|legitimate|not a scam)\b[^.!?\n]{0,40}\b(?:ai|scanner|classifier|model)\b/i,
      /\b(?:ai|scanner|classifier|model|assistant)\b[^.!?\n]{0,30}\b(?:this|the) (?:message|email|link) is (?:safe|legitimate|not a scam)\b/i,
    ],
  },
];

function isNegated(text: string, matchIndex: number, negations: RegExp[] | undefined) {
  if (!negations) return false;
  const before = text.slice(Math.max(0, matchIndex - 60), matchIndex);
  return negations.some((n) => n.test(before));
}

function firstMatch(rule: TextRule, text: string): string | null {
  for (const pattern of rule.patterns) {
    const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
    for (const m of text.matchAll(global)) {
      if (m[0].trim().length === 0) continue;
      if (isNegated(text, m.index ?? 0, rule.negations)) continue;
      return m[0];
    }
  }
  return null;
}

export function runTextRules(normalizedText: string): Indicator[] {
  const indicators: Indicator[] = [];
  for (const rule of TEXT_RULES) {
    const evidence = firstMatch(rule, normalizedText);
    if (evidence === null) continue;
    indicators.push({
      code: rule.id,
      category: rule.category,
      severity: rule.severity,
      description: rule.description,
      evidence: clipEvidence(evidence),
      source: "rules",
    });
  }
  return indicators;
}

/** Signals derived from the text's form rather than its wording. */
export function runObfuscationChecks(original: string, invisibleCharCount: number): Indicator[] {
  const out: Indicator[] = [];
  if (invisibleCharCount >= 2) {
    out.push({
      code: "HIDDEN_CHARACTERS",
      category: "obfuscation",
      severity: "medium",
      description: "The text contains invisible characters, a trick used to slip past spam filters.",
      evidence: `${invisibleCharCount} invisible characters`,
      source: "rules",
    });
  }
  // A single word mixing Latin with Cyrillic/Greek letters is a classic look-alike trick (e.g. "pаypal").
  const mixed = original.match(/(?<!\p{L})(?=\p{L}*\p{Script=Latin})(?=\p{L}*[\p{Script=Cyrillic}\p{Script=Greek}])\p{L}{3,}(?!\p{L})/u);
  if (mixed) {
    out.push({
      code: "MIXED_SCRIPT_WORD",
      category: "obfuscation",
      severity: "medium",
      description: "A word mixes letters from different alphabets, which is used to imitate brand names.",
      evidence: clipEvidence(mixed[0]),
      source: "rules",
    });
  }
  return out;
}

export const TEXT_RULE_DEFINITIONS: (RuleDefinition & { appliesTo: string })[] = [
  ...TEXT_RULES.map(({ id, category, severity, description }) => ({ id, category, severity, description, appliesTo: "text,email" })),
  { id: "HIDDEN_CHARACTERS", category: "obfuscation" as IndicatorCategory, severity: "medium" as Severity, description: "Invisible characters present.", appliesTo: "text,email" },
  { id: "MIXED_SCRIPT_WORD", category: "obfuscation" as IndicatorCategory, severity: "medium" as Severity, description: "Word mixes alphabets.", appliesTo: "text,email" },
];
