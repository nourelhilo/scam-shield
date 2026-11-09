import { createHash, randomBytes } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";

/**
 * Credential primitives built only from established, vetted components:
 *  - Passwords: Argon2id via @node-rs/argon2 (OWASP-recommended parameters).
 *  - Session / one-time tokens: 256-bit CSPRNG values; only their SHA-256 digest is stored,
 *    so a database leak does not reveal usable tokens.
 * No custom cryptographic protocol is implemented here.
 */
const ARGON2_OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const; // OWASP: m=19 MiB, t=2, p=1

export function hashPassword(password: string) {
  return hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string) {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

// A real Argon2id hash of a random value, used to equalise timing when a user does not exist.
let dummyHash: Promise<string> | null = null;
export function dummyPasswordHash() {
  dummyHash ??= hashPassword(randomBytes(16).toString("hex"));
  return dummyHash;
}

export function generateToken(prefix: string) {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}
