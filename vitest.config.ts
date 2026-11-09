import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // Tests never call real external services: AI, SMTP, and OCR are faked.
    env: { NODE_ENV: "test" },
  },
});
