import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Serve the frontend's static files from
 * the same origin as the API, so no CORS setup is needed.
 *
 * Only this explicit allow-list is served - never arbitrary paths - so server files,
 * .env, and the database directory can never be reached through this route.
 * The files are served exactly as they are on disk, with one documented exception:
 * if index.html has an EMPTY data-analysis-endpoint attribute, the served copy points it
 * at /api/analyze. The file on disk is never modified.
 */
const FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
  "/checker.js": { file: "checker.js", type: "text/javascript; charset=utf-8" },
  "/reset-password": { file: "reset-password.html", type: "text/html; charset=utf-8" },
  "/reset-password.js": { file: "reset-password.js", type: "text/javascript; charset=utf-8" },
  "/retro-terminal.svg": { file: "retro-terminal.svg", type: "image/svg+xml" },
};

export async function frontendRoutes(app: FastifyInstance, { accounts = true }: { accounts?: boolean }) {
  for (const [route, { file, type }] of Object.entries(FILES)) {
    if (!accounts && (route === "/reset-password" || route === "/reset-password.js")) continue;
    app.get(route, async (_request, reply) => {
      let body: string;
      try {
        body = await readFile(path.join(ROOT, file), "utf8");
      } catch {
        return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Frontend file not found." } });
      }
      if (file === "index.html") body = body.replace('data-analysis-endpoint=""', 'data-analysis-endpoint="/api/analyze"');
      if (file === "reset-password.html") {
        return reply.type(type).header("Cache-Control", "no-store").header("Referrer-Policy", "no-referrer").send(body);
      }
      return reply.type(type).header("Cache-Control", "no-cache").send(body);
    });
  }
}
