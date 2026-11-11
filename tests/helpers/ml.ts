import { InProcessEngine, MlEngineError, type EngineStatus, type MlEngine } from "../../server/ml/engine.ts";
import { loadModelFromDir, type LinearTextModel, type ModelInfo, type Prediction } from "../../server/ml/linear-model.ts";
import { DEFAULT_MODEL_DIR } from "../../server/ml/model-path.ts";

/** The real trained model, loaded once per test process (JSON parse + checksum ~30 ms). */
let shared: LinearTextModel | null = null;
export function realModel(): LinearTextModel {
  return (shared ??= loadModelFromDir(DEFAULT_MODEL_DIR));
}

export function realEngine(): MlEngine {
  return new InProcessEngine({ model: realModel() });
}

/**
 * TEST DOUBLE engine. Used ONLY to simulate failures (timeouts, crashes, malformed output)
 * or a deliberately fooled model. It is never used for "successful ML" assertions: those
 * run the real model.
 */
export class FakeEngine implements MlEngine {
  readonly name = "fake-test-double";
  calls = 0;
  constructor(
    private readonly behaviour: (text: string) => Promise<Prediction>,
    private readonly state: EngineStatus["state"] = "ready",
  ) {}
  status(): EngineStatus {
    return { engine: this.name, state: this.state, modelVersion: this.state === "ready" ? "fake-0" : null, reason: null, workers: 1, queueDepth: 0 };
  }
  async ready() {
    return this.status();
  }
  info(): ModelInfo | null {
    return null;
  }
  async predict(text: string, timeoutMs: number): Promise<Prediction> {
    this.calls++;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new MlEngineError("timeout", "Inference timed out.")), timeoutMs);
    });
    try {
      return await Promise.race([this.behaviour(text), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
  async close() {}
}

export const hangingEngine = () => new FakeEngine(() => new Promise(() => undefined));
export const crashingEngine = () => new FakeEngine(async () => { throw new MlEngineError("engine_error", "boom"); });

/** A prediction that claims the text is clearly legitimate (simulates a fooled model). */
export function fooledPrediction(): Prediction {
  return {
    modelVersion: "fake-0",
    probability: 0.01,
    decision: -4.6,
    band: "low",
    label: "legitimate",
    truncated: false,
    knownFeatures: 10,
    explanation: { towardSuspicious: [], towardLegitimate: [{ term: "safe", display: "safe", weight: -3 }], contributionTotal: -4.6 },
  };
}
