/**
 * Inference worker thread. Loads the verified model ONCE at startup, then answers
 * { id, text } messages with predictions. Never receives or loads anything else.
 * Erasable TypeScript only (may run on Node's built-in type stripping).
 */
import { parentPort, workerData } from "node:worker_threads";
import { loadModelFromDir, type LinearTextModel } from "./linear-model.ts";

const port = parentPort;
if (!port) throw new Error("inference-worker must run as a worker thread");

const { modelDir, maxChars } = workerData as { modelDir: string; maxChars: number };

let model: LinearTextModel;
try {
  model = loadModelFromDir(modelDir);
  port.postMessage({ type: "ready", info: model.info });
} catch (error) {
  port.postMessage({ type: "load_failed", reason: error instanceof Error ? error.name : "Error" });
  process.exit(1);
}

port.on("message", (msg: { id?: unknown; text?: unknown }) => {
  const id = typeof msg?.id === "number" ? msg.id : -1;
  if (typeof msg?.text !== "string" || msg.text.length > maxChars) {
    port.postMessage({ type: "result", id, ok: false, error: "invalid_input" });
    return;
  }
  try {
    port.postMessage({ type: "result", id, ok: true, prediction: model.predict(msg.text) });
  } catch {
    // Never echo the input or the stack back: errors carry no content.
    port.postMessage({ type: "result", id, ok: false, error: "inference_error" });
  }
});
