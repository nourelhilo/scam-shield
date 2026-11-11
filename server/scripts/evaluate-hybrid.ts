/**
 * Evaluate rules-only vs. ML-only vs. hybrid decisions on the prepared dataset splits.
 *
 * Usage:  npm run ml:evaluate-hybrid [-- --partition validation|test|both]
 * Needs ml/data/processed/dataset.jsonl.gz (run the ML data preparation first).
 * Writes ml/artifacts/<model>/hybrid_metrics.json. Prints aggregate numbers only - never
 * message content.
 *
 * "Flagged" means the final risk level is MEDIUM or HIGH. The hybrid policy is CHOSEN on
 * the validation split; the test split is reported once for the chosen policy.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { runDetection } from "../detection/detect.ts";
import type { RiskLevel } from "../detection/types.ts";
import { InProcessEngine } from "../ml/engine.ts";
import { MlService } from "../ml/ml-service.ts";
import { combineSignals, type HybridPolicy } from "../risk/hybrid.ts";
import { assessRisk } from "../risk/risk-engine.ts";
import { DEFAULT_MODEL_DIR } from "../ml/model-path.ts";

interface Row {
  item_id: string;
  source: string;
  source_label: string;
  fraud_specific: boolean;
  channel: "sms" | "email";
  label: 0 | 1;
  partition: string;
  text: string;
}

const POLICIES: Record<string, HybridPolicy> = {
  hybrid_ml_only_cannot_raise: { mlOnlyCanRaise: false },
  hybrid_ml_only_can_raise: { mlOnlyCanRaise: true },
};

type Counts = { tp: number; fp: number; tn: number; fn: number; unknown: number; levels: Record<string, Record<RiskLevel, number>> };
const newCounts = (): Counts => ({ tp: 0, fp: 0, tn: 0, fn: 0, unknown: 0, levels: { legitimate: { low: 0, medium: 0, high: 0, unknown: 0 }, suspicious: { low: 0, medium: 0, high: 0, unknown: 0 } } });

function add(c: Counts, label: 0 | 1, level: RiskLevel) {
  c.levels[label ? "suspicious" : "legitimate"]![level]++;
  if (level === "unknown") c.unknown++;
  const flagged = level === "medium" || level === "high";
  if (label && flagged) c.tp++;
  else if (label) c.fn++;
  else if (flagged) c.fp++;
  else c.tn++;
}

function summarise(c: Counts) {
  const precision = c.tp + c.fp ? c.tp / (c.tp + c.fp) : null;
  const recall = c.tp + c.fn ? c.tp / (c.tp + c.fn) : null;
  const f1 = precision && recall ? (2 * precision * recall) / (precision + recall) : null;
  return {
    flagged_is_medium_or_high: true,
    confusion: { tp: c.tp, fp: c.fp, tn: c.tn, fn: c.fn },
    precision, recall, f1,
    false_positive_rate: c.fp + c.tn ? c.fp / (c.fp + c.tn) : null,
    false_negative_rate: c.fn + c.tp ? c.fn / (c.fn + c.tp) : null,
    unknown_count: c.unknown,
    level_distribution: c.levels,
  };
}

function splitEmail(text: string) {
  const i = text.indexOf("\n\n");
  return i < 0 ? { subject: text, body: "" } : { subject: text.slice(0, i), body: text.slice(i + 2) };
}

async function evaluate(rows: Row[], ml: MlService) {
  const systems = ["rules_only", "ml_only", ...Object.keys(POLICIES)];
  const overall = Object.fromEntries(systems.map((s) => [s, newCounts()]));
  const byGroup: Record<string, Record<string, Counts>> = {};
  const group = (name: string, system: string) => ((byGroup[name] ??= {})[system] ??= newCounts());

  for (const row of rows) {
    const type = row.channel === "sms" ? "text" : "email";
    const detection = type === "text" ? runDetection({ type, content: row.text }) : runDetection({ type, content: "", email: splitEmail(row.text) });
    const rule = assessRisk(detection.indicators, { inputType: type, insufficientContent: detection.insufficientContent, unanalyzable: detection.unanalyzable });
    const outcome = await ml.analyze({ type, text: detection.modelText, language: detection.language, insufficientContent: detection.insufficientContent });

    const levels: Record<string, RiskLevel> = {
      rules_only: rule.riskLevel,
      // ML alone: suspicious when p >= 0.5; LOW otherwise; UNKNOWN when the model did not run.
      ml_only: outcome.status !== "used" ? "unknown" : outcome.probability! >= 0.5 ? "medium" : "low",
    };
    for (const [name, policy] of Object.entries(POLICIES)) {
      levels[name] = combineSignals({ inputType: type, ruleIndicators: detection.indicators, rule, ml: outcome, insufficientContent: detection.insufficientContent, unanalyzable: detection.unanalyzable }, policy).riskLevel;
    }
    const groups = [`channel=${row.channel}`, `source=${row.source}`, row.label ? (row.fraud_specific ? "subset=fraud_specific" : "subset=generic_spam") : `subset=legitimate:${row.source_label}`];
    for (const s of systems) {
      add(overall[s]!, row.label, levels[s]!);
      for (const g of groups) add(group(g, s), row.label, levels[s]!);
    }
  }
  return {
    n: rows.length,
    overall: Object.fromEntries(Object.entries(overall).map(([k, v]) => [k, summarise(v)])),
    groups: Object.fromEntries(Object.entries(byGroup).sort().map(([g, s]) => [g, Object.fromEntries(Object.entries(s).map(([k, v]) => [k, summarise(v)]))])),
  };
}

async function main() {
  const root = path.resolve(import.meta.dirname, "../..");
  const datasetPath = path.join(root, "ml/data/processed/dataset.jsonl.gz");
  const rows: Row[] = gunzipSync(readFileSync(datasetPath)).toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const engine = new InProcessEngine({ modelDir: DEFAULT_MODEL_DIR });
  const info = engine.info();
  if (!info) throw new Error("Model could not be loaded.");
  const ml = new MlService(engine, { timeoutMs: 5000, maxInputChars: 12_000 });

  const arg = process.argv.indexOf("--partition");
  const which = arg > 0 ? process.argv[arg + 1] : "both";
  const partitions = which === "both" ? ["validation", "test"] : [which!];
  const result: Record<string, unknown> = { model_version: info.modelVersion, model_sha256: info.sha256, generated_by: "server/scripts/evaluate-hybrid.ts" };
  for (const p of partitions) {
    result[p] = await evaluate(rows.filter((r) => r.partition === p), ml);
    const o = (result[p] as Awaited<ReturnType<typeof evaluate>>).overall;
    console.log(`\n${p}:`);
    for (const [s, m] of Object.entries(o)) {
      console.log(`  ${s.padEnd(30)} P=${m.precision?.toFixed(4)} R=${m.recall?.toFixed(4)} F1=${m.f1?.toFixed(4)} FPR=${m.false_positive_rate?.toFixed(4)} unknown=${m.unknown_count}`);
    }
  }
  const out = path.join(DEFAULT_MODEL_DIR, "hybrid_metrics.json");
  writeFileSync(out, JSON.stringify(result, null, 1) + "\n");
  console.log(`\nwrote ${path.relative(root, out)}`);
}

await main();
