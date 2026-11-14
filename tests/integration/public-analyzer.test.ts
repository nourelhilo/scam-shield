import { expect, it } from "vitest";
import { buildAnalyzerApp } from "../../server/app.ts";
import { createMlEngine } from "../../server/bootstrap.ts";
import { loadConfig } from "../../server/config.ts";
import { MlService } from "../../server/ml/ml-service.ts";

it("serves the production analyzer without PostgreSQL or mail services", async () => {
  const env = { NODE_ENV: "production", MAIL_TRANSPORT: "smtp", ML_ENGINE: "in-process" };
  expect(() => loadConfig(env)).toThrow("DATABASE_URL is required");
  const config = loadConfig(env, { analyzerOnly: true });
  const ml = new MlService(createMlEngine(config.ml), {
    timeoutMs: config.ml.timeoutMs,
    maxInputChars: config.ml.maxInputChars,
  });
  await ml.ready();
  const app = await buildAnalyzerApp(config, ml);
  try {
    const health = await app.inject("/api/health");
    expect(health.statusCode).toBe(200);
    expect(health.json().capabilities).toMatchObject({ analysis: true, ml: true, accounts: false, ocr: false });

    const page = await app.inject("/");
    expect(page.body).toContain('data-analysis-endpoint="/api/analyze"');
    const payload = { type: "text", content: "Your delivery is on hold. Pay a redelivery fee at http://parcel-fee.example" };
    const result = await app.inject({ method: "POST", url: "/api/analyze", payload });
    expect(result.statusCode).toBe(200);
    expect(result.json().mlPrediction.status).toBe("used");

    const save = await app.inject({ method: "POST", url: "/api/analyze", payload: { ...payload, save: true } });
    expect(save.statusCode).toBe(503);
    expect((await app.inject({ method: "POST", url: "/api/auth/register", payload: {} })).statusCode).toBe(404);
    expect((await app.inject("/reset-password")).statusCode).toBe(404);
  } finally {
    await app.close();
  }
});
