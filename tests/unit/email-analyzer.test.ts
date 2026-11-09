import { describe, expect, it } from "vitest";
import { analyzeEmailSender, parseAddress, parseEmail } from "../../server/detection/email-analyzer.ts";
import { runDetection } from "../../server/detection/detect.ts";

const senderCodes = (raw: string, links: string[] = []) => analyzeEmailSender(parseEmail(raw), links).map((i) => i.code);

describe("email parsing", () => {
  it("parses header lines and body", () => {
    const e = parseEmail("From: \"PayPal\" <alerts@paypal.com>\nReply-To: x@evil.example\nSubject: Hello\n\nBody line 1\nBody line 2");
    expect(e.fromName).toBe("PayPal");
    expect(e.fromAddress).toBe("alerts@paypal.com");
    expect(e.fromDomain).toBe("paypal.com");
    expect(e.replyToDomain).toBe("evil.example");
    expect(e.subject).toBe("Hello");
    expect(e.body).toBe("Body line 1\nBody line 2");
  });

  it("parses the frontend's subject-only format", () => {
    const e = parseEmail("Subject: Immediate action required\n\nYour account will be locked today.");
    expect(e.subject).toBe("Immediate action required");
    expect(e.fromAddress).toBeNull();
  });

  it("accepts structured fields", () => {
    const e = parseEmail("", { from: "Bank <a@b.example>", subject: "S", body: "B" });
    expect(e.fromAddress).toBe("a@b.example");
    expect(e.body).toBe("B");
  });

  it("parses bare and display-name addresses", () => {
    expect(parseAddress("a@b.com")).toEqual({ name: null, address: "a@b.com" });
    expect(parseAddress("Alice <A@B.com>")).toEqual({ name: "Alice", address: "a@b.com" });
    expect(parseAddress("just a name")).toEqual({ name: "just a name", address: null });
  });
});

describe("email sender checks", () => {
  it("flags a brand display name sent from another domain", () => {
    expect(senderCodes("From: PayPal Support <help@secure-mail.example>\n\nhi")).toContain("EMAIL_SENDER_BRAND_MISMATCH");
  });
  it("does not flag a brand sent from its official domain", () => {
    expect(senderCodes("From: PayPal <service@paypal.com>\n\nhi")).toEqual([]);
  });
  it("flags look-alike sender domains", () => {
    expect(senderCodes("From: Support <a@paypa1.com>\n\nhi")).toContain("EMAIL_LOOKALIKE_SENDER_DOMAIN");
  });
  it("flags an address hidden in the display name", () => {
    expect(senderCodes("From: \"service@paypal.com\" <x@evil.example>\n\nhi")).toContain("EMAIL_DISPLAY_NAME_SPOOF");
  });
  it("flags organisations using free mail", () => {
    expect(senderCodes("From: Bank Security Team <banksecure@gmail.com>\n\nhi")).toContain("EMAIL_FREE_MAIL_ORGANIZATION");
  });
  it("does not flag Google sending from gmail.com as free mail", () => {
    expect(senderCodes("From: Google <no-reply@gmail.com>\n\nhi")).not.toContain("EMAIL_FREE_MAIL_ORGANIZATION");
  });
  it("flags reply-to domain mismatches", () => {
    expect(senderCodes("From: a@shop.example\nReply-To: b@other.example\n\nhi")).toContain("EMAIL_REPLY_TO_MISMATCH");
  });
  it("flags links that do not match the claimed brand", () => {
    expect(senderCodes("From: Netflix <info@netflix.com>\n\nhi", ["netflix-billing.example"])).toContain("EMAIL_LINK_DOMAIN_MISMATCH");
    expect(senderCodes("From: Netflix <info@netflix.com>\n\nhi", ["netflix.com"])).not.toContain("EMAIL_LINK_DOMAIN_MISMATCH");
  });
});

describe("email detection (end to end)", () => {
  it("marks the sender as unverified and combines rule types", () => {
    const r = runDetection({
      type: "email",
      content: "From: PayPal <service@paypa1-help.com>\nSubject: Account limited\n\nYour account has been limited. Click the link below to verify your account: http://paypal-verify.top/x",
    });
    expect(r.email?.senderVerified).toBe(false);
    const codes = r.indicators.map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(["ACCOUNT_SUSPENSION", "EMAIL_SENDER_BRAND_MISMATCH", "EMAIL_LINK_DOMAIN_MISMATCH"]));
  });
});
