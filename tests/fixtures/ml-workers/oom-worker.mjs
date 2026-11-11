// Test fixture: allocates until the worker's heap limit kills it.
import { parentPort } from "node:worker_threads";
parentPort.postMessage({ type: "ready", info: { modelVersion: "oom-test" } });
parentPort.on("message", () => {
  const hoard = [];
  for (;;) hoard.push(new Array(1e6).fill(Math.random()));
});
