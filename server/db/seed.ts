import type { Database } from "./database.ts";
import { ArticleRepository, type ArticleCategory } from "../repositories/index.ts";

interface SeedArticle {
  slug: string;
  title: string;
  category: ArticleCategory;
  language: "en" | "ar";
  summary: string;
  body: string;
}

/** Starter educational content (plain text with simple line breaks; render as text, not HTML). */
export const SEED_ARTICLES: SeedArticle[] = [
  {
    slug: "spotting-phishing-messages",
    title: "How to spot a phishing message",
    category: "phishing",
    language: "en",
    summary: "Phishing messages imitate trusted organisations to steal your login details. Learn the warning signs.",
    body: `Phishing is when someone pretends to be a trusted organisation, such as your bank, a delivery company, or a streaming service, to trick you into giving away passwords, codes, or payment details.

Common warning signs:
- Pressure to act immediately ("your account will be closed today").
- A link to "verify" or "unlock" your account.
- Requests for passwords, one-time codes, or card numbers. Legitimate companies do not ask for these by message.
- A sender address or link that does not match the company's real website.
- Generic greetings such as "Dear customer".

What to do:
- Do not click the link. Open the company's app or type its address yourself.
- Never share one-time codes with anyone, even someone claiming to be from the company.
- Report the message to the company and delete it.`,
  },
  {
    slug: "fake-shopping-websites",
    title: "Recognising fake shopping websites",
    category: "fake_shopping",
    language: "en",
    summary: "Fake online shops take payment and never deliver. Here is how to check a shop before you buy.",
    body: `Fake shops often appear in social media ads and search results, offering popular products at prices that are too good to be true.

Check before you buy:
- Look up the shop's name together with words like "reviews" or "scam".
- Be suspicious of very recent domains, misspelled brand names, or unusual endings in the web address.
- Look for real contact details, a physical address, and a clear returns policy.
- Prefer payment methods with buyer protection, such as a credit card. Avoid bank transfers, gift cards, and cryptocurrency.

If you already paid, contact your bank or card provider immediately and ask about a chargeback.`,
  },
  {
    slug: "sms-scams-smishing",
    title: "SMS scams (smishing): parcels, banks, and fines",
    category: "sms_scams",
    language: "en",
    summary: "Text messages about held parcels, unpaid fines, or blocked cards are among the most common scams.",
    body: `Smishing is phishing by text message. Typical examples:
- "Your parcel is on hold. Pay a small redelivery fee."
- "Your bank card has been blocked. Verify here."
- "You have an unpaid toll or traffic fine."

These messages use short deadlines and small amounts so you act without thinking. The link leads to a page that steals your card details.

Protect yourself:
- Check deliveries only in the courier's official app or website.
- Call your bank using the number on the back of your card.
- Never reply with codes or personal details.
- Forward scam texts to your mobile operator's spam-reporting number if one exists in your country.`,
  },
  {
    slug: "email-fraud-basics",
    title: "Email fraud: fake invoices, CEO requests, and look-alike senders",
    category: "email_fraud",
    language: "en",
    summary: "Fraudulent emails can look professional. Learn to check senders, links, and payment requests.",
    body: `Email fraud includes fake invoices, urgent requests that appear to come from a manager, and messages from look-alike addresses (for example "paypa1.com" instead of "paypal.com").

Remember that the name shown as the sender can be set to anything. The address behind it, and the domain of any links, matter more, but even these can be faked. Only your email provider can check technical authentication (SPF, DKIM, DMARC).

Before acting on a payment or account request:
- Confirm it using a phone number or contact you already know.
- Hover over links to see where they really go.
- Be wary of replies that go to a different address than the sender.
- Treat unexpected attachments with caution.`,
  },
  {
    slug: "account-impersonation",
    title: "Account impersonation: when a friend or company is not who they seem",
    category: "account_impersonation",
    language: "en",
    summary: "Scammers impersonate friends, family, and support teams on messaging apps and social media.",
    body: `Impersonation scams often start with "Hi mum, I have a new number" or a message from a "support agent" who contacted you first.

Warning signs:
- A familiar person writing from a new number or account and asking for money.
- Support staff who message you first, or ask you to install remote-access apps.
- Requests to move the conversation to another app.
- Asking for the verification code you just received. This is how accounts get hijacked.

Verify by calling the person on their known number, or by contacting the company through its official app. Turn on two-step verification for messaging and social media accounts.`,
  },
  {
    slug: "online-payment-safety",
    title: "Paying safely online",
    category: "payment_safety",
    language: "en",
    summary: "How you pay determines whether you can get your money back. Choose protected payment methods.",
    body: `Scammers ask for payment methods that are fast and hard to reverse: gift cards, cryptocurrency, wire transfers, and money-transfer services.

Safer habits:
- Use credit cards or payment services with buyer protection.
- Never pay with gift cards. No legitimate company, government office, or utility asks for this.
- Check the payee name before confirming a bank transfer.
- Do not share one-time codes. They authorise payments.

If you think you have been scammed, contact your bank immediately, record what happened, and report it to your local fraud-reporting service.`,
  },
  {
    slug: "sms-scams-arabic",
    title: "رسائل الاحتيال النصية: كيف تحمي نفسك",
    category: "sms_scams",
    language: "ar",
    summary: "رسائل عن شحنات معلقة أو حسابات موقوفة هي من أكثر أساليب الاحتيال انتشاراً.",
    body: `يرسل المحتالون رسائل تدّعي أن شحنتك معلقة أو أن حسابك البنكي موقوف، ويطلبون منك الضغط على رابط أو إرسال رمز التحقق.

علامات التحذير:
- الاستعجال والتهديد بإيقاف الحساب.
- طلب كلمة المرور أو رمز التحقق أو بيانات البطاقة.
- روابط لا تطابق الموقع الرسمي للجهة.

ماذا تفعل:
- لا تضغط على الرابط، وافتح التطبيق الرسمي بنفسك.
- لا تشارك رمز التحقق مع أي شخص.
- تواصل مع البنك عبر الرقم الموجود على بطاقتك.`,
  },
];

export async function seedArticles(db: Database) {
  const repo = new ArticleRepository(db);
  let inserted = 0;
  for (const article of SEED_ARTICLES) {
    const created = await repo.create({ ...article, status: "published", createdBy: null });
    if (created) inserted++;
  }
  return inserted;
}
