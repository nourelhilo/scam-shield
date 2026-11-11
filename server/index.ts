import { createServer } from "./bootstrap.ts";
import { loadConfig } from "./config.ts";

const config = loadConfig();
const app = await createServer(config);

await app.listen({ host: config.host, port: config.port });
app.log.info(
  { ml: app.ctx.ml.status() ?? "disabled", database: app.ctx.db.kind, ocr: app.ctx.ocr.enabled },
  "ScamShield API ready",
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    process.exit(0);
  });
}
