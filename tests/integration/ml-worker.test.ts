import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { MlEngineError, WorkerPoolEngine, type WorkerPoolOptions } from "../../server/ml/engine.ts";
import { MlService } from "../../server/ml/ml-service.ts";
import { DEFAULT_MODEL_DIR } from "../../server/ml/model-path.ts";
import { createTestApp } from "../helpers/app.ts";
import { realModel } from "../helpers/ml.ts";

// Real worker threads running the real model. Fixture workers simulate hangs, crashes, and memory blow-ups.

const fixture = (name: string) => new URL(`../fixtures/ml-workers/${name}`, import.meta.url);
const engines: WorkerPoolEngine[] = [];
const pool = (opts: Partial<WorkerPoolOptions> = {}) => {
  const e = new WorkerPoolEngine({ modelDir: DEFAULT_MODEL_DIR, workers: 1, maxQueue: 16, maxChars: 12_000, maxHeapMb: 256, ...opts });
  engines.push(e);
  return e;
};
afterAll(async () => {
  await Promise.all(engines.map((e) => e.close()));
});

describe("WorkerPoolEngine with the real model", () => {
  it("loads the model once and predicts exactly like the in-process model", async () => {
    const e = pool();
    expect((await e.ready()).state).toBe("ready");
    const text = "Your parcel is waiting. Pay the customs fee at https://parcel-fee.top today";
    const p = await e.predict(text, 2000);
    expect(p.probability).toBeCloseTo(realModel().predict(text).probability, 12);
    expect(e.status()).toMatchObject({ engine: "worker-pool", modelVersion: "scamshield-text-v1.0.0", workers: 1 });
  });

  it("answers concurrent requests correctly with two workers", async () => {
    const e = pool({ workers: 2, maxQueue: 100 });
    await e.ready();
    const texts = Array.from({ length: 60 }, (_, i) => (i % 2 ? `Lunch at ${i}? I'll book a table for us.` : `URGENT ${i}: confirm your bank PIN at http://bank-${i}.top`));
    const results = await Promise.all(texts.map((t) => e.predict(t, 5000)));
    results.forEach((r, i) => expect(r.probability).toBeCloseTo(realModel().predict(texts[i]!).probability, 12));
  });

  it("bounds the queue instead of growing without limit", async () => {
    const e = pool({ maxQueue: 2, workerUrl: fixture("hang-worker.mjs") });
    await e.ready();
    // One job runs on the (stuck) worker, two wait in the queue, the fourth is refused at once.
    const pending = ["a b c", "d e f", "g h i", "j k l"].map((t) => e.predict(t, 400));
    const outcomes = await Promise.allSettled(pending);
    const kinds = outcomes.map((o) => (o.status === "rejected" ? (o.reason as MlEngineError).kind : "ok"));
    expect(kinds).toEqual(["timeout", "timeout", "timeout", "queue_full"]);
  });

  it("times out a stuck worker, terminates it, and replaces it", async () => {
    const e = pool({ workerUrl: fixture("hang-worker.mjs") });
    await e.ready();
    const started = Date.now();
    await expect(e.predict("stuck", 300)).rejects.toMatchObject({ kind: "timeout" });
    expect(Date.now() - started).toBeLessThan(1500);
    await new Promise((r) => setTimeout(r, 300));
    expect(e.status().state).toBe("ready"); // a fresh worker replaced the stuck one
  });

  it("reports a crashing worker as engine_error and stops after the restart budget", async () => {
    const e = pool({ workerUrl: fixture("crash-worker.mjs"), maxCrashes: 2 });
    await e.ready();
    for (let i = 0; i < 3; i++) {
      await expect(e.predict("boom", 2000)).rejects.toMatchObject({ kind: expect.stringMatching(/engine_error|unavailable/) });
      await new Promise((r) => setTimeout(r, 150));
    }
    expect(e.status()).toMatchObject({ state: "unavailable", reason: "worker_crash_loop" });
    await expect(e.predict("again", 500)).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("kills a worker that exceeds its heap limit", async () => {
    const e = pool({ workerUrl: fixture("oom-worker.mjs"), maxHeapMb: 64 });
    await e.ready();
    await expect(e.predict("allocate", 15_000)).rejects.toMatchObject({ kind: "engine_error" });
  }, 20_000);

  it("refuses to start with a tampered model and reports why", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "scamshield-tampered-"));
    try {
      cpSync(path.join(DEFAULT_MODEL_DIR, "manifest.json"), path.join(dir, "manifest.json"));
      writeFileSync(path.join(dir, "model.json"), '{"format":"scamshield-linear-text-model"}');
      const e = pool({ modelDir: dir });
      expect(await e.ready()).toMatchObject({ state: "unavailable", reason: "model_integrity_check_failed" });
      await expect(e.predict("hello there friend", 500)).rejects.toMatchObject({ kind: "unavailable" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects oversized input before it reaches a worker", async () => {
    const e = pool({ maxChars: 100 });
    await e.ready();
    await expect(e.predict("x".repeat(101), 500)).rejects.toMatchObject({ kind: "invalid_input" });
  });
});

describe("MlService over the worker pool", () => {
  it("logs metadata only, never the submitted text", async () => {
    const events: Record<string, unknown>[] = [];
    const svc = new MlService(pool(), { timeoutMs: 2000, maxInputChars: 12_000, log: (e) => events.push(e) });
    await svc.ready();
    const secret = "my account number is 99887766 and my secret word is pineapple-zebra";
    const r = await svc.analyze({ type: "text", text: secret, language: "en", insufficientContent: false });
    expect(r.status).toBe("used");
    expect(events.length).toBe(1);
    const logged = JSON.stringify(events);
    expect(logged).not.toContain("pineapple");
    expect(logged).not.toContain("99887766");
    expect(Object.keys(events[0]!).sort()).toEqual(["band", "event", "modelVersion", "ms", "reason", "status"]);
  });

  it("skips input above its limit rather than truncating silently", async () => {
    const svc = new MlService(pool(), { timeoutMs: 2000, maxInputChars: 50, log: () => undefined });
    const r = await svc.analyze({ type: "text", text: "word ".repeat(20), language: "en", insufficientContent: false });
    expect(r).toMatchObject({ status: "not_applicable", reason: "input_too_large", probability: null });
  });
});

describe("HTTP API on the worker engine", () => {
  it("serves concurrent analyses predictably", async () => {
    const t = await createTestApp({ mlEngine: pool({ workers: 2, maxQueue: 64 }) });
    try {
      await t.app.ctx.ml.ready();
      const payloads = Array.from({ length: 30 }, (_, i) => ({ type: "text", content: i % 2 ? "Are we still on for dinner on Friday at 7?" : `Your account ${i} is suspended. Verify your password now at http://acct-${i}.top` }));
      const responses = await Promise.all(payloads.map((payload) => t.app.inject({ method: "POST", url: "/api/analyze", payload })));
      for (const [i, res] of responses.entries()) {
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.mlPrediction.status).toBe("used");
        expect(body.riskLevel).toBe(i % 2 ? "low" : "high");
      }
      const health = (await t.app.inject({ method: "GET", url: "/api/health" })).json();
      expect(health.capabilities.ml).toBe(true);
    } finally {
      await t.close();
    }
  });
});
