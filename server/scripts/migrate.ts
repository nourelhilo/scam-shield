import { loadConfig } from "../config.ts";
import { createDatabase } from "../db/database.ts";
import { migrate } from "../db/migrate.ts";

/** Apply pending migrations. Forward-only and non-destructive. */
const config = loadConfig();
const db = await createDatabase({ url: config.db.url, pgliteDataDir: config.db.pgliteDataDir ?? ".data/pglite" });
const applied = await migrate(db);
console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Database is up to date.");
await db.close();
