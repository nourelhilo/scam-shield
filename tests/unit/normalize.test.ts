import { describe, expect, it } from "vitest";
import { clipEvidence, detectLanguage, normalizeArabic, normalizeText } from "../../server/detection/normalize.ts";

describe("normalisation", () => {
  it("removes invisible characters and counts them", () => {
    const r = normalizeText("pa\u200Bss\u200Dword");
    expect(r.text).toBe("password");
    expect(r.invisibleCharCount).toBe(2);
  });
  it("converts Arabic-Indic digits", () => {
    expect(normalizeText("رمز ١٢٣٤ و ۵۶").text).toContain("1234");
    expect(normalizeText("۵۶").text).toBe("56");
  });
  it("unifies Arabic letter variants and strips diacritics", () => {
    expect(normalizeArabic("أرسِلْ الرمزَ فوراً")).toBe("ارسل الرمز فورا");
    expect(normalizeArabic("جائزة")).toBe("جائزه");
  });
  it("detects language", () => {
    expect(detectLanguage("Your account is blocked")).toBe("en");
    expect(detectLanguage("تم تعليق حسابك")).toBe("ar");
    expect(detectLanguage("PayPal تم تعليق حسابك account")).toBe("mixed");
    expect(detectLanguage("12345")).toBe("unknown");
  });
  it("clips evidence", () => {
    expect(clipEvidence("a  b\n c")).toBe("a b c");
    expect(clipEvidence("x".repeat(200), 10)).toHaveLength(10);
  });
});
