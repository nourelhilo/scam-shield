import { loadConfig } from "../config.ts";
import { createDatabase } from "../db/database.ts";
import { seedArticles } from "../db/seed.ts";

/** Insert the starter educational articles. Idempotent: existing slugs are left untouched. */
const config = loadConfig();
const db = await createDatabase({ url: config.db.url, pgliteDataDir: config.db.pgliteDataDir ?? ".data/pglite" });
const inserted = await seedArticles(db);
console.log(`Seeded ${inserted} new article(s).`);
await db.close();
