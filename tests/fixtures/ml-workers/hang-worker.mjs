// Test fixture: reports ready, then never answers (simulates stuck inference).
import { parentPort } from "node:worker_threads";
parentPort.postMessage({ type: "ready", info: { modelVersion: "hang-test" } });
parentPort.on("message", () => {
  for (;;) {
    // busy loop: only terminate() can stop this
  }
});
