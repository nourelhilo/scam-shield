import { loadConfig } from "../config.ts";
import { createDatabase } from "../db/database.ts";
import { AuditLogRepository, UserRepository } from "../repositories/index.ts";

/**
 * Grant or revoke the admin role. There is intentionally no HTTP endpoint for this:
 * bootstrap admins from a trusted shell with database access.
 *   npm run admin:promote -- someone@example.com
 *   npm run admin:promote -- someone@example.com --revoke
 */
const email = process.argv[2];
const revoke = process.argv.includes("--revoke");
if (!email || email.startsWith("-")) {
  console.error("Usage: npm run admin:promote -- <email> [--revoke]");
  process.exit(1);
}
const config = loadConfig();
const db = await createDatabase({ url: config.db.url, pgliteDataDir: config.db.pgliteDataDir ?? ".data/pglite" });
const ok = await new UserRepository(db).setRole(email, revoke ? "user" : "admin");
if (ok) {
  await new AuditLogRepository(db).record({ actorId: null, action: revoke ? "admin.role_revoked_cli" : "admin.role_granted_cli", targetType: "user", metadata: { email } });
}
console.log(ok ? `${email} is now ${revoke ? "a regular user" : "an admin"}.` : `No account found for ${email}.`);
await db.close();
process.exit(ok ? 0 : 1);
