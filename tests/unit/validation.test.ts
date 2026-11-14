import { describe, expect, it } from "vitest";
import { AnalyzeRequestSchema } from "../../server/analysis/schemas.ts";
import { EmailSchema, PasswordSchema } from "../../server/auth/auth-service.ts";
import { loadConfig } from "../../server/config.ts";
import { sniffImageType, validateImageUpload } from "../../server/ocr/file-validation.ts";

describe("analyze request validation", () => {
  const ok = (v: unknown) => AnalyzeRequestSchema.safeParse(v).success;
  it("accepts the frontend's request shape", () => {
    expect(ok({ type: "text", content: "Your delivery is on hold." })).toBe(true);
    expect(ok({ type: "url", content: "https://example.com" })).toBe(true);
    expect(ok({ type: "email", content: "Subject: x\n\nbody" })).toBe(true);
  });
  it("accepts structured email fields", () => {
    expect(ok({ type: "email", email: { from: "a@b.c", subject: "s", body: "b" } })).toBe(true);
  });
  it.each([
    [{ type: "sms", content: "x" }, "unknown type"],
    [{ type: "text" }, "missing content"],
    [{ type: "text", content: "   " }, "blank content"],
    [{ type: "text", content: 42 }, "non-string content"],
    [{ type: "text", content: "x".repeat(10_001) }, "oversized content"],
    [{ type: "text", content: "x", extra: true }, "unknown field"],
    [{ type: "text", content: "x", email: { body: "y" } }, "email fields on text"],
    [{ type: "url", content: "https://a.com and more" }, "url with spaces"],
    [{ type: "text", content: "x", save: "yes" }, "non-boolean save"],
    [null, "null body"],
    ["just a string", "string body"],
  ] as [unknown, string][])("rejects %j (%s)", (value) => {
    expect(ok(value)).toBe(false);
  });
});

describe("credential validation", () => {
  it("enforces password length", () => {
    expect(PasswordSchema.safeParse("short").success).toBe(false);
    expect(PasswordSchema.safeParse(" ".repeat(12)).success).toBe(false);
    expect(PasswordSchema.safeParse("x".repeat(129)).success).toBe(false);
    expect(PasswordSchema.safeParse("long enough passphrase").success).toBe(true);
  });
  it("validates emails", () => {
    expect(EmailSchema.safeParse("person@example.com").success).toBe(true);
    expect(EmailSchema.safeParse("not-an-email").success).toBe(false);
  });
});

describe("upload validation", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
  const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]);
  it("identifies images by magic bytes", () => {
    expect(sniffImageType(png)).toBe("image/png");
    expect(sniffImageType(jpeg)).toBe("image/jpeg");
    expect(sniffImageType(webp)).toBe("image/webp");
  });
  it.each([
    ["SVG", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
    ["HTML", Buffer.from("<html><script>alert(1)</script></html>")],
    ["PDF", Buffer.from("%PDF-1.7")],
    ["ELF executable", Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1])],
    ["ZIP", Buffer.from([0x50, 0x4b, 0x03, 0x04])],
  ])("rejects %s", (_name, buffer) => {
    expect(() => validateImageUpload(buffer, 1024 * 1024)).toThrowError(/PNG, JPEG, or WebP/);
  });
  it("rejects empty and oversized files", () => {
    expect(() => validateImageUpload(Buffer.alloc(0), 100)).toThrowError(/empty/);
    expect(() => validateImageUpload(Buffer.concat([png, Buffer.alloc(200)]), 100)).toThrowError(/smaller/);
  });
});

describe("configuration", () => {
  it("requires DATABASE_URL and SMTP in production", () => {
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrowError(/DATABASE_URL/);
    expect(() => loadConfig({ NODE_ENV: "production", DATABASE_URL: "postgres://x" })).toThrowError(/MAIL_TRANSPORT=smtp/);
  });
  it("requires an explicit https PUBLIC_APP_URL in production and accepts a complete production config", () => {
    const prod = { NODE_ENV: "production", DATABASE_URL: "postgres://u:p@db:5432/scamshield", MAIL_TRANSPORT: "smtp", SMTP_URL: "smtps://u:p@smtp.example.com:465" };
    expect(() => loadConfig(prod)).toThrowError(/PUBLIC_APP_URL/);
    expect(() => loadConfig({ ...prod, PUBLIC_APP_URL: "http://scamshield.example" })).toThrowError(/PUBLIC_APP_URL/);
    const config = loadConfig({ ...prod, PUBLIC_APP_URL: "https://scamshield.example/" });
    expect(config.publicAppUrl).toBe("https://scamshield.example");
    expect(config.corsOrigins).toEqual([]);
  });
  it("rejects malformed DATABASE_URL and SMTP_URL without echoing them", () => {
    expect(() => loadConfig({ NODE_ENV: "test", DATABASE_URL: "mysql://secret-pw@h/db" })).toThrowError(/DATABASE_URL/);
    expect(() => loadConfig({ NODE_ENV: "test", SMTP_URL: "http://secret-pw@h" })).toThrowError(/SMTP_URL/);
    try {
      loadConfig({ NODE_ENV: "test", SMTP_URL: "http://secret-pw@h" });
    } catch (error) {
      expect(String(error)).not.toContain("secret-pw");
    }
  });
  it("ignores removed external-AI settings instead of requiring a key, and reports them", () => {
    const config = loadConfig({ NODE_ENV: "test", AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "legacy-value-should-not-be-used" });
    expect(config.legacyAiSettings.sort()).toEqual(["AI_PROVIDER", "ANTHROPIC_API_KEY"]);
    expect(JSON.stringify(config)).not.toContain("legacy-value-should-not-be-used");
  });
  it("does not echo secret values in configuration errors", () => {
    try {
      loadConfig({ NODE_ENV: "test", PORT: "super-secret-value" });
    } catch (error) {
      expect(String(error)).not.toContain("super-secret-value");
    }
  });
  it("enables the local ML classifier by default with a worker engine and bounded limits", () => {
    const { ml } = loadConfig({ NODE_ENV: "test" });
    expect(ml).toMatchObject({ enabled: true, engine: "worker", workers: 1, timeoutMs: 1500, maxQueue: 64 });
  });
  it("can disable the ML classifier", () => {
    expect(loadConfig({ NODE_ENV: "test", ML_ENABLED: "false" }).ml.enabled).toBe(false);
  });
  it("rejects out-of-range ML limits", () => {
    expect(() => loadConfig({ NODE_ENV: "test", ML_TIMEOUT_MS: "999999" })).toThrowError(/ML_TIMEOUT_MS/);
    expect(() => loadConfig({ NODE_ENV: "test", ML_ENGINE: "remote" })).toThrowError(/ML_ENGINE/);
  });
});
