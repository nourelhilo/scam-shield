import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { charNgrams, MAX_MODEL_CHARS, NORMALIZER_VERSION, normalizeForModel, wordNgrams, wordTokens } from "./text-features.ts";

/**
 * Loader and predictor for ScamShield's own linear text classifier
 * (exported by ml/scamshield_ml/train.py).
 *
 * Safety: the artifact is plain JSON (terms, IDF values, weights, thresholds). It is parsed
 * with JSON.parse and validated with a strict schema; nothing in it is executed. Its SHA-256
 * digest must match manifest.json, so a corrupted or swapped file is refused.
 *
 * Erasable TypeScript only - this module is loaded inside the inference worker thread.
 */
export const MODEL_FORMAT = "scamshield-linear-text-model";
export const MODEL_FORMAT_VERSION = 1;

const BlockSchema = z
  .object({
    kind: z.enum(["word", "char"]),
    min_n: z.number().int().min(1).max(8),
    max_n: z.number().int().min(1).max(8),
    weighting: z.enum(["sublinear_tfidf_l2", "raw_count"]),
    terms: z.array(z.string().max(200)).max(500_000),
    idf: z.array(z.number().finite()).nullable(),
    weights: z.array(z.number().finite()),
  })
  .refine((b) => b.weights.length === b.terms.length && (b.idf === null || b.idf.length === b.terms.length), "array length mismatch")
  .refine((b) => b.min_n <= b.max_n, "min_n > max_n")
  .refine((b) => (b.weighting === "sublinear_tfidf_l2") === (b.idf !== null), "idf must be present exactly for tf-idf blocks");

const ModelSchema = z.object({
  format: z.literal(MODEL_FORMAT),
  format_version: z.literal(MODEL_FORMAT_VERSION),
  model_version: z.string().regex(/^[a-z0-9.-]{3,64}$/),
  algorithm: z.enum(["logistic_regression", "linear_svm", "multinomial_nb"]),
  normalizer_version: z.literal(NORMALIZER_VERSION),
  max_chars: z.literal(MAX_MODEL_CHARS),
  supported_languages: z.array(z.string()).min(1),
  positive_label: z.literal("suspicious"),
  intercept: z.number().finite(),
  probability: z.discriminatedUnion("type", [
    z.object({ type: z.literal("logistic") }),
    z.object({ type: z.literal("platt"), a: z.number().finite(), b: z.number().finite() }).passthrough(),
  ]),
  bands: z
    .object({ low_below: z.number().min(0).max(0.5), elevated_from: z.number().min(0).max(1), strong_from: z.number().min(0.5).max(1) })
    .passthrough()
    .refine((b) => b.low_below <= b.elevated_from && b.elevated_from <= b.strong_from, "bands out of order"),
  training: z.record(z.string(), z.unknown()),
  blocks: z.array(BlockSchema).min(1).max(4),
});

const ManifestSchema = z.object({
  model_version: z.string(),
  files: z.object({ "model.json": z.string().regex(/^[0-9a-f]{64}$/) }),
});

export type MlBand = "low" | "uncertain" | "elevated" | "strong";

export interface TermContribution {
  /** Normalised term as the model saw it (lower-case, digits as 0, links as "urltoken"). */
  term: string;
  /** Human-readable form ("[link]", "[number]", or the word itself). */
  display: string;
  /** Additive contribution to the model's log-odds. Positive = toward "suspicious". */
  weight: number;
}

export interface Prediction {
  modelVersion: string;
  probability: number;
  decision: number;
  band: MlBand;
  label: "suspicious" | "legitimate";
  /** True when the normalised text reached the model's character limit and was cut. */
  truncated: boolean;
  /** Number of features from the submission that exist in the model vocabulary. */
  knownFeatures: number;
  explanation: {
    towardSuspicious: TermContribution[];
    towardLegitimate: TermContribution[];
    /** Sum of every term contribution plus the intercept; equals `decision`. */
    contributionTotal: number;
  };
}

export interface ModelInfo {
  modelVersion: string;
  algorithm: string;
  sha256: string;
  supportedLanguages: string[];
  bands: { lowBelow: number; elevatedFrom: number; strongFrom: number };
  vocabularySize: number;
}

interface Block {
  kind: "word" | "char";
  minN: number;
  maxN: number;
  tfidf: boolean;
  index: Map<string, number>;
  idf: Float64Array | null;
  weights: Float64Array;
}

export class ModelIntegrityError extends Error {
  override name = "ModelIntegrityError";
}

const PLACEHOLDER_DISPLAY: Record<string, string> = { urltoken: "[link]", emailtoken: "[email address]", moneytoken: "[currency symbol]" };

export function displayTerm(term: string): string {
  if (PLACEHOLDER_DISPLAY[term]) return PLACEHOLDER_DISPLAY[term];
  if (/^0+$/.test(term)) return "[number]";
  if (term === "!") return "[exclamation marks]";
  return term.replace(/0/g, "#");
}

export class LinearTextModel {
  readonly info: ModelInfo;
  private readonly blocks: Block[];
  private readonly intercept: number;
  private readonly prob: { type: "logistic" } | { type: "platt"; a: number; b: number };
  private readonly bands: { lowBelow: number; elevatedFrom: number; strongFrom: number };

  constructor(raw: unknown, sha256: string) {
    const parsed = ModelSchema.safeParse(raw);
    if (!parsed.success) throw new ModelIntegrityError("Model file failed schema validation.");
    const doc = parsed.data;
    this.intercept = doc.intercept;
    this.prob = doc.probability.type === "logistic" ? { type: "logistic" } : { type: "platt", a: doc.probability.a, b: doc.probability.b };
    this.bands = { lowBelow: doc.bands.low_below, elevatedFrom: doc.bands.elevated_from, strongFrom: doc.bands.strong_from };
    this.blocks = doc.blocks.map((b) => {
      const index = new Map<string, number>();
      b.terms.forEach((t, i) => index.set(t, i));
      if (index.size !== b.terms.length) throw new ModelIntegrityError("Model vocabulary contains duplicate terms.");
      return {
        kind: b.kind,
        minN: b.min_n,
        maxN: b.max_n,
        tfidf: b.weighting === "sublinear_tfidf_l2",
        index,
        idf: b.idf ? Float64Array.from(b.idf) : null,
        weights: Float64Array.from(b.weights),
      };
    });
    this.info = {
      modelVersion: doc.model_version,
      algorithm: doc.algorithm,
      sha256,
      supportedLanguages: doc.supported_languages,
      bands: this.bands,
      vocabularySize: this.blocks.reduce((n, b) => n + b.index.size, 0),
    };
  }

  band(probability: number): MlBand {
    if (probability >= this.bands.strongFrom) return "strong";
    if (probability >= this.bands.elevatedFrom) return "elevated";
    if (probability < this.bands.lowBelow) return "low";
    return "uncertain";
  }

  private probability(decision: number): number {
    const z = this.prob.type === "logistic" ? decision : this.prob.a * decision + this.prob.b;
    return z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));
  }

  /** Real inference over the submitted text, with an additive per-term explanation. */
  predict(text: string, topK = 6): Prediction {
    const normalized = normalizeForModel(text);
    const tokens = wordTokens(normalized);
    const tokenScore = new Float64Array(tokens.length);
    const pieces = normalized.split(" ");
    const pieceScore = new Float64Array(pieces.length);
    let decision = this.intercept;
    let knownFeatures = 0;

    for (const block of this.blocks) {
      const occurrences: { j: number; start: number; n: number }[] = [];
      if (block.kind === "word") {
        for (const g of wordNgrams(normalized, block.minN, block.maxN)) {
          const j = block.index.get(g.gram);
          if (j !== undefined) occurrences.push({ j, start: g.start, n: g.n });
        }
      } else {
        for (const g of charNgrams(normalized, block.minN, block.maxN)) {
          const j = block.index.get(g.gram);
          if (j !== undefined) occurrences.push({ j, start: g.piece, n: 0 });
        }
      }
      // Term counts in first-occurrence order (matches the Python reference summation order).
      const counts = new Map<number, number>();
      for (const o of occurrences) counts.set(o.j, (counts.get(o.j) ?? 0) + 1);
      knownFeatures += counts.size;

      const values = new Map<number, number>();
      if (block.tfidf) {
        let sq = 0;
        for (const [j, c] of counts) {
          const v = (1 + Math.log(c)) * block.idf![j]!;
          values.set(j, v);
          sq += v * v;
        }
        const norm = Math.sqrt(sq);
        for (const [j, v] of values) values.set(j, norm > 0 ? v / norm : 0);
      } else {
        for (const [j, c] of counts) values.set(j, c);
      }

      let blockScore = 0;
      for (const [j, v] of values) blockScore += v * block.weights[j]!;
      decision += blockScore;

      // Attribute each feature's contribution evenly to the occurrences that produced it.
      for (const o of occurrences) {
        const share = (values.get(o.j)! * block.weights[o.j]!) / counts.get(o.j)!;
        if (block.kind === "word") {
          for (let k = 0; k < o.n; k++) tokenScore[o.start + k]! += share / o.n;
        } else {
          pieceScore[o.start]! += share;
        }
      }
    }

    // Character n-grams belong to a space-separated piece; spread a piece's score over its word tokens.
    const termScores = new Map<string, number>();
    const add = (term: string, value: number) => termScores.set(term, (termScores.get(term) ?? 0) + value);
    let tokenCursor = 0;
    for (let p = 0; p < pieces.length; p++) {
      const inPiece = wordTokens(pieces[p]!).length;
      if (inPiece === 0) {
        if (pieceScore[p]) add("!", pieceScore[p]!);
        continue;
      }
      for (let k = 0; k < inPiece; k++) tokenScore[tokenCursor + k]! += pieceScore[p]! / inPiece;
      tokenCursor += inPiece;
    }
    tokens.forEach((t, i) => add(t, tokenScore[i]!));

    let contributionTotal = this.intercept;
    for (const v of termScores.values()) contributionTotal += v;
    const ranked = [...termScores].map(([term, weight]) => ({ term, display: displayTerm(term), weight }));
    const round = (c: TermContribution) => ({ ...c, weight: Math.round(c.weight * 1000) / 1000 });
    const towardSuspicious = ranked.filter((c) => c.weight > 0).sort((a, b) => b.weight - a.weight).slice(0, topK).map(round);
    const towardLegitimate = ranked.filter((c) => c.weight < 0).sort((a, b) => a.weight - b.weight).slice(0, Math.max(1, Math.floor(topK / 2))).map(round);

    const probability = this.probability(decision);
    return {
      modelVersion: this.info.modelVersion,
      probability,
      decision,
      band: this.band(probability),
      label: probability >= 0.5 ? "suspicious" : "legitimate",
      truncated: normalized.length >= MAX_MODEL_CHARS,
      knownFeatures,
      explanation: { towardSuspicious, towardLegitimate, contributionTotal },
    };
  }
}

/**
 * Load `<dir>/model.json`, verify its SHA-256 against `<dir>/manifest.json`, and validate it.
 * Throws ModelIntegrityError on any mismatch; never falls back to an unverified file.
 */
export function loadModelFromDir(dir: string): LinearTextModel {
  const manifestRaw = readFileSync(path.join(dir, "manifest.json"), "utf8");
  const manifest = ManifestSchema.safeParse(JSON.parse(manifestRaw));
  if (!manifest.success) throw new ModelIntegrityError("Model manifest is invalid.");
  const bytes = readFileSync(path.join(dir, "model.json"));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== manifest.data.files["model.json"]) throw new ModelIntegrityError("Model file checksum does not match its manifest.");
  const model = new LinearTextModel(JSON.parse(bytes.toString("utf8")), sha256);
  if (model.info.modelVersion !== manifest.data.model_version) throw new ModelIntegrityError("Model version does not match its manifest.");
  return model;
}
