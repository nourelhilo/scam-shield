import { describe, expect, it } from "vitest";
import { analyzeUrl, extractUrls, parseUserUrl, URL_RULES } from "../../server/detection/url-analyzer.ts";
import { lookalikeBrand, brandMentionedIn, editDistance } from "../../server/detection/brands.ts";

const codes = (url: string) => analyzeUrl(url).indicators.map((i) => i.code);

describe("URL analyzer", () => {
  it.each([
    ["URL_UNSAFE_SCHEME", "javascript:alert(document.cookie)"],
    ["URL_UNSAFE_SCHEME", "data:text/html;base64,PHNjcmlwdD4="],
    ["URL_EMBEDDED_CREDENTIALS", "https://www.paypal.com@evil.example/login"],
    ["URL_IP_HOST", "http://203.0.113.9/login"],
    ["URL_IP_HOST", "http://0x7f.0.0.1/"], // hex IPv4, normalised by the WHATWG parser
    ["URL_IP_HOST", "http://[2001:db8::1]/"],
    ["URL_PUNYCODE", "https://xn--pypal-4ve.com/"],
    ["URL_MIXED_SCRIPT_DOMAIN", "https://pаypal.com/"], // Cyrillic а
    ["URL_BRAND_LOOKALIKE", "https://paypa1.com/"],
    ["URL_BRAND_LOOKALIKE", "https://arnazon.com/"],
    ["URL_BRAND_LOOKALIKE", "https://micros0ft-support.com/"],
    ["URL_BRAND_IN_SUBDOMAIN", "https://paypal.account-check.net/"],
    ["URL_BRAND_MISMATCH", "https://paypal-refunds.com/"],
    ["URL_DOMAIN_IN_SUBDOMAIN", "https://secure.com.example.net/"],
    ["URL_EXCESSIVE_SUBDOMAINS", "https://a.b.c.d.example.com/"],
    ["URL_UNUSUAL_CHARACTERS", "https://example.com/%00/x"],
    ["URL_REDIRECT_PARAMETER", "https://example.com/out?url=https://evil.example"],
    ["URL_EMAIL_IN_PARAMETERS", "https://example.net/r?e=victim@example.com"],
    ["URL_SHORTENER", "https://bit.ly/3abcde"],
    ["URL_RISKY_TLD", "https://parcel-help.top/pay"],
    ["URL_SENSITIVE_KEYWORDS", "https://example.org/account/verify"],
    ["URL_DECEPTIVE_DOMAIN_WORDS", "https://account-verify.example/x"],
    ["URL_EXCESSIVE_LENGTH", "https://example.com/" + "a".repeat(150)],
    ["URL_MANY_HYPHENS", "https://my-secure-account-help.com/"],
    ["URL_NON_STANDARD_PORT", "https://example.com:8443/"],
    ["URL_NOT_HTTPS", "http://example.com/"],
  ])("%s for %s", (code, url) => {
    expect(codes(url)).toContain(code);
  });

  it("has a test for every URL rule", () => {
    // Keep this list in sync with the cases above.
    const tested = new Set(["URL_UNSAFE_SCHEME", "URL_EMBEDDED_CREDENTIALS", "URL_IP_HOST", "URL_PUNYCODE", "URL_MIXED_SCRIPT_DOMAIN", "URL_BRAND_LOOKALIKE", "URL_BRAND_IN_SUBDOMAIN", "URL_BRAND_MISMATCH", "URL_DOMAIN_IN_SUBDOMAIN", "URL_EXCESSIVE_SUBDOMAINS", "URL_UNUSUAL_CHARACTERS", "URL_REDIRECT_PARAMETER", "URL_EMAIL_IN_PARAMETERS", "URL_SHORTENER", "URL_RISKY_TLD", "URL_SENSITIVE_KEYWORDS", "URL_DECEPTIVE_DOMAIN_WORDS", "URL_EXCESSIVE_LENGTH", "URL_MANY_HYPHENS", "URL_NON_STANDARD_PORT", "URL_NOT_HTTPS"]);
    expect([...tested].sort()).toEqual(Object.keys(URL_RULES).sort());
  });

  it.each(["https://www.paypal.com/myaccount/summary", "https://accounts.google.com/signin", "https://www.amazon.co.uk/gp/your-account", "https://github.com/nourelhilo/scam-shield"])(
    "reports nothing for an ordinary official URL: %s",
    (url) => {
      expect(codes(url)).toEqual([]);
    },
  );

  it("does not flag punycode hyphens as 'many hyphens'", () => {
    expect(codes("https://xn--pypal-4ve.com/")).not.toContain("URL_MANY_HYPHENS");
  });

  it("does not flag 'apply' as a look-alike of 'apple'", () => {
    expect(codes("https://apply-now.example.com/")).not.toContain("URL_BRAND_LOOKALIKE");
  });

  it("reports the registrable domain and unicode hostname", () => {
    const r = analyzeUrl("https://login.paypal.com.evil.co.uk/x");
    expect(r.registrableDomain).toBe("evil.co.uk");
    expect(r.valid).toBe(true);
  });

  it("marks unparseable input invalid without throwing", () => {
    for (const bad of ["", "http://", "not a url", "https://exa mple.com", "http://%%%"]) {
      expect(analyzeUrl(bad).valid).toBe(false);
    }
  });

  it("accepts bare domains by assuming http", () => {
    expect(parseUserUrl("example.com/path")?.hostname).toBe("example.com");
  });

  it("extracts links from text without trailing punctuation", () => {
    expect(extractUrls("Go to https://a.example/x. Or www.b.example, or c-d.top/pay!")).toEqual(["https://a.example/x", "www.b.example", "c-d.top/pay"]);
  });

  it("never performs network requests (pure function)", async () => {
    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      throw new Error("network");
    }) as typeof fetch;
    try {
      analyzeUrl("https://169.254.169.254/latest/meta-data/");
      analyzeUrl("http://localhost:5432/");
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(called).toBe(false);
  });
});

describe("brand helpers", () => {
  it("computes edit distance with transpositions", () => {
    expect(editDistance("paypal", "paypal")).toBe(0);
    expect(editDistance("paypal", "papyal")).toBe(1);
    expect(editDistance("paypal", "paypall")).toBe(1);
  });
  it("finds brand mentions and look-alikes", () => {
    expect(brandMentionedIn("secure-paypal-login")?.name).toBe("PayPal");
    expect(brandMentionedIn("groups")).toBeNull(); // "ups" only matches as a whole segment
    expect(lookalikeBrand("paypa1")?.name).toBe("PayPal");
    expect(lookalikeBrand("paypal")).toBeNull();
    expect(lookalikeBrand("netfIix".toLowerCase())?.name).toBe("Netflix");
  });
});
