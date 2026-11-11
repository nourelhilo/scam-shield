import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { LinearTextModel, loadModelFromDir, ModelIntegrityError, displayTerm } from "../../server/ml/linear-model.ts";
import { DEFAULT_MODEL_DIR, DEFAULT_MODEL_VERSION } from "../../server/ml/model-path.ts";
import { charNgrams, normalizeForModel, wordNgrams } from "../../server/ml/text-features.ts";
import { realModel } from "../helpers/ml.ts";

// Real trained model, no doubles. Fixtures were produced by the Python reference implementation.
const fixtures: { text: string; normalized: string; decision: number; probability: number }[] = JSON.parse(
  readFileSync(path.join(DEFAULT_MODEL_DIR, "parity_fixtures.json"), "utf8"),
).fixtures;

describe("Python/TypeScript parity (ml/scamshield_ml is the specification)", () => {
  it("has a meaningful number of fixtures", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(80);
  });

  it.each(fixtures.map((f, i) => [i, f] as const))("fixture %i normalises identically and scores within 1e-9", (_i, f) => {
    expect(normalizeForModel(f.text)).toBe(f.normalized);
    const p = realModel().predict(f.text);
    expect(Math.abs(p.decision - f.decision)).toBeLessThan(1e-9);
    expect(Math.abs(p.probability - f.probability)).toBeLessThan(1e-9);
  });
});

describe("text normalisation", () => {
  it("replaces links, emails, currency, and digits with stable placeholders", () => {
    expect(normalizeForModel("Pay £50 at https://x.top/a?b=1 or mail a.b@c.co.uk by 9pm")).toBe("pay moneytoken 00 at urltoken or mail emailtoken by 0pm");
  });
  it("removes zero-width obfuscation and accents, and lower-cases ASCII only", () => {
    expect(normalizeForModel("Pay​Pal ACCÖUNT")).toBe("paypal account");
  });
  it("unifies Arabic spelling variants and digits", () => {
    expect(normalizeForModel("أَحْمَد إلى مكتبةٌ ٣٤")).toBe(normalizeForModel("احمد الي مكتبه 34"));
  });
  it("caps very long input at the model limit", () => {
    expect(normalizeForModel("word ".repeat(5000)).length).toBe(10_000);
  });
  it("builds word 1-2-grams and padded character n-grams", () => {
    expect(wordNgrams("verify your account", 1, 2).map((g) => g.gram)).toEqual(["verify", "your", "account", "verify your", "your account"]);
    expect(charNgrams("ab", 3, 4).map((g) => g.gram)).toEqual([" ab", "ab ", " ab "]);
  });
});

describe("LinearTextModel (real artifact)", () => {
  const model = realModel();

  it("loads the committed, checksum-verified model", () => {
    expect(model.info).toMatchObject({ modelVersion: DEFAULT_MODEL_VERSION, algorithm: "logistic_regression", supportedLanguages: ["en"] });
    expect(model.info.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns a well-formed prediction with an exact additive explanation", () => {
    const p = model.predict("URGENT: your bank account is locked. Confirm your PIN at http://secure-bank-login.top now");
    expect(p.probability).toBeGreaterThan(0);
    expect(p.probability).toBeLessThan(1);
    expect(p.label).toBe(p.probability >= 0.5 ? "suspicious" : "legitimate");
    expect(Math.abs(p.explanation.contributionTotal - p.decision)).toBeLessThan(1e-9);
    expect(p.explanation.towardSuspicious.every((t) => t.weight > 0)).toBe(true);
    expect(p.explanation.towardLegitimate.every((t) => t.weight < 0)).toBe(true);
  });

  it("is deterministic", () => {
    const text = "Congratulations! You have been selected for a cash prize, reply YES";
    expect(model.predict(text)).toEqual(model.predict(text));
  });

  it.each([
    ["short", "ok see you"],
    ["empty", ""],
    ["only symbols", "!!! ??? ..."],
    ["misspelled", "Congratulashions u hav won a prize, clame now"],
    ["obfuscated", "V-e-r-i-f-y your b@nk acc0unt n0w"],
    ["mixed Arabic/English", "عزيزي العميل your account is suspended"],
    ["long", "Please review the attached document before Thursday. ".repeat(180)],
  ])("handles %s input without throwing", (_name, text) => {
    const p = model.predict(text);
    expect(Number.isFinite(p.probability)).toBe(true);
  });

  it("marks truncation when normalised text reaches the model limit", () => {
    expect(model.predict("word ".repeat(5000)).truncated).toBe(true);
    expect(model.predict("short text here").truncated).toBe(false);
  });

  it("predicts a 10,000-character input quickly", () => {
    const text = "Dear customer please verify your account now ".repeat(220);
    const started = performance.now();
    for (let i = 0; i < 10; i++) model.predict(text);
    expect((performance.now() - started) / 10).toBeLessThan(50);
  });

  it("renders placeholder terms for humans", () => {
    expect(displayTerm("urltoken")).toBe("[link]");
    expect(displayTerm("0000")).toBe("[number]");
    expect(displayTerm("0day")).toBe("#day");
    expect(displayTerm("verify")).toBe("verify");
  });
});

describe("model artifact integrity", () => {
  const dirs: string[] = [];
  const copy = () => {
    const dir = mkdtempSync(path.join(tmpdir(), "scamshield-model-"));
    dirs.push(dir);
    cpSync(path.join(DEFAULT_MODEL_DIR, "model.json"), path.join(dir, "model.json"));
    cpSync(path.join(DEFAULT_MODEL_DIR, "manifest.json"), path.join(dir, "manifest.json"));
    return dir;
  };
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  it("refuses a model file whose checksum does not match the manifest", () => {
    const dir = copy();
    const file = path.join(dir, "model.json");
    writeFileSync(file, readFileSync(file, "utf8").replace('"intercept":', '"intercept": 0, "x":'));
    expect(() => loadModelFromDir(dir)).toThrowError(ModelIntegrityError);
  });

  it("refuses a manifest without a valid digest", () => {
    const dir = copy();
    writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ model_version: "x", files: { "model.json": "not-a-hash" } }));
    expect(() => loadModelFromDir(dir)).toThrowError(ModelIntegrityError);
  });

  it("refuses structurally invalid model documents even with a matching hash", () => {
    const bad = [
      {},
      { format: "pickle", payload: "gASV..." },
      { ...JSON.parse(readFileSync(path.join(DEFAULT_MODEL_DIR, "model.json"), "utf8")), normalizer_version: "norm-v0" },
    ];
    for (const doc of bad) expect(() => new LinearTextModel(doc, "0".repeat(64))).toThrowError(ModelIntegrityError);
  });

  it("refuses mismatched array lengths", () => {
    const doc = JSON.parse(readFileSync(path.join(DEFAULT_MODEL_DIR, "model.json"), "utf8"));
    doc.blocks[0].weights = doc.blocks[0].weights.slice(1);
    expect(() => new LinearTextModel(doc, "0".repeat(64))).toThrowError(ModelIntegrityError);
  });

  it("is plain JSON data (no executable serialisation)", () => {
    const raw = readFileSync(path.join(DEFAULT_MODEL_DIR, "model.json"), "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(raw.startsWith("{")).toBe(true);
  });
});
