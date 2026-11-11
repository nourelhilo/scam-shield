// Test fixture: reports ready, then exits on every request (simulates a crashing process).
import { parentPort } from "node:worker_threads";
parentPort.postMessage({ type: "ready", info: { modelVersion: "crash-test" } });
parentPort.on("message", () => process.exit(3));
