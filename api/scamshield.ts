import { buildAnalyzerApp } from "../server/app.ts";
import { createMlEngine, createServer } from "../server/bootstrap.ts";
import { loadConfig } from "../server/config.ts";
import { MlService } from "../server/ml/ml-service.ts";

const analyzerOnly = !process.env.DATABASE_URL?.trim() || !process.env.SMTP_URL?.trim() || !process.env.MAIL_FROM?.trim();
const config = loadConfig({
  ...process.env,
  NODE_ENV: "production",
  ML_ENGINE: "in-process",
  DB_AUTO_MIGRATE: "false",
  TRUST_PROXY: process.env.VERCEL === "1" ? "true" : process.env.TRUST_PROXY,
}, { analyzerOnly });
let app;
if (analyzerOnly) {
  const ml = new MlService(createMlEngine(config.ml), { timeoutMs: config.ml.timeoutMs, maxInputChars: config.ml.maxInputChars });
  await ml.ready();
  app = await buildAnalyzerApp(config, ml);
  app.log.info("Running the public analyzer without account services.");
} else {
  app = await createServer(config);
}
// Vercel wraps the HTTP server created by Fastify. An ephemeral port also
// lets this entry point run outside Vercel without conflicting with npm start.
await app.listen({ host: "127.0.0.1", port: 0 });
