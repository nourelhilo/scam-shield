import { z } from "zod";
import { AppError, unauthorized } from "../lib/errors.ts";
import type { Repositories, UserRow } from "../repositories/index.ts";
import { dummyPasswordHash, generateToken, hashPassword, hashToken, verifyPassword } from "./crypto.ts";
import type { Mailer } from "./mailer.ts";

export const PasswordSchema = z
  .string()
  .min(10, "Password must be at least 10 characters.")
  .max(128, "Password must be 128 characters or fewer.")
  .refine((p) => p.trim().length >= 10, "Password must contain at least 10 non-space characters.");

export const EmailSchema = z.string().trim().max(254).email("Enter a valid email address.");

const VERIFY_TTL_MS = 24 * 3600 * 1000;
const RESET_TTL_MS = 30 * 60 * 1000;

export interface PublicUser {
  id: string;
  email: string;
  displayName: string | null;
  role: "user" | "admin";
  emailVerified: boolean;
  createdAt: string;
}

export function toPublicUser(user: UserRow): PublicUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    role: user.role,
    emailVerified: user.email_verified_at !== null,
    createdAt: new Date(user.created_at).toISOString(),
  };
}

export interface AuthContext {
  user: UserRow;
  sessionId: string;
}

export interface AuthServiceOptions {
  publicAppUrl: string;
  sessionTtlMs: number;
  requireEmailVerification: boolean;
}

export class AuthService {
  constructor(
    private readonly repos: Repositories,
    private readonly mailer: Mailer,
    private readonly options: AuthServiceOptions,
  ) {}

  /**
   * Register a new account. The response is identical whether or not the email already
   * exists, so the endpoint cannot be used to discover registered addresses.
   */
  async register(input: { email: string; password: string; displayName?: string | null | undefined }) {
    const passwordHash = await hashPassword(input.password);
    const user = await this.repos.users.create({ email: input.email, passwordHash, displayName: input.displayName ?? null });
    if (user) {
      await this.sendVerification(user);
    } else {
      await this.mailer.send({
        to: input.email.trim(),
        subject: "ScamShield sign-up attempt",
        text: "Someone tried to create a ScamShield account with this email address, but an account already exists. If this was you, sign in or reset your password. Otherwise you can ignore this email.",
      });
    }
  }

  private async sendVerification(user: UserRow) {
    const token = generateToken("ev");
    await this.repos.tokens.create(user.id, "email_verification", hashToken(token), new Date(Date.now() + VERIFY_TTL_MS));
    await this.mailer.send({
      to: user.email,
      subject: "Verify your ScamShield email",
      text: `Confirm your email address to finish setting up ScamShield:\n\n${this.options.publicAppUrl}/api/auth/verify-email?token=${encodeURIComponent(token)}\n\nVerification token: ${token}\n\nThis link expires in 24 hours. If you did not sign up, ignore this email.`,
    });
  }

  async resendVerification(email: string) {
    const user = await this.repos.users.findByEmailWithHash(email);
    if (user && !user.email_verified_at) await this.sendVerification(user);
  }

  async verifyEmail(token: string) {
    const userId = await this.repos.tokens.consume("email_verification", hashToken(token));
    if (!userId) throw new AppError(400, "INVALID_TOKEN", "This verification link is invalid or has expired.");
    await this.repos.users.markVerified(userId);
  }

  async login(input: { email: string; password: string; userAgent: string | null }) {
    const user = await this.repos.users.findByEmailWithHash(input.email);
    // Always run a hash verification so response time does not reveal whether the account exists.
    const valid = await verifyPassword(user?.password_hash ?? (await dummyPasswordHash()), input.password);
    if (!user || !valid) throw new AppError(401, "INVALID_CREDENTIALS", "Incorrect email or password.");
    if (this.options.requireEmailVerification && !user.email_verified_at) {
      throw new AppError(403, "EMAIL_NOT_VERIFIED", "Verify your email address before signing in.");
    }
    await this.repos.sessions.purgeExpired().catch(() => undefined);
    const token = generateToken("ss");
    const expiresAt = new Date(Date.now() + this.options.sessionTtlMs);
    await this.repos.sessions.create(user.id, hashToken(token), expiresAt, input.userAgent);
    const { password_hash: _ignored, ...publicRow } = user;
    return { token, expiresAt, user: toPublicUser(publicRow) };
  }

  async authenticate(token: string): Promise<AuthContext> {
    if (!/^ss_[A-Za-z0-9_-]{43}$/.test(token)) throw unauthorized("Your session is invalid. Sign in again.");
    const session = await this.repos.sessions.findValid(hashToken(token));
    if (!session) throw unauthorized("Your session has expired. Sign in again.");
    await this.repos.sessions.touch(session.session_id).catch(() => undefined);
    return { user: session.user, sessionId: session.session_id };
  }

  logout(sessionId: string) {
    return this.repos.sessions.delete(sessionId);
  }

  logoutEverywhere(userId: string) {
    return this.repos.sessions.deleteAllForUser(userId);
  }

  async requestPasswordReset(email: string) {
    const user = await this.repos.users.findByEmailWithHash(email);
    if (!user) return; // same response either way
    const token = generateToken("pr");
    await this.repos.tokens.create(user.id, "password_reset", hashToken(token), new Date(Date.now() + RESET_TTL_MS));
    await this.mailer.send({
      to: user.email,
      subject: "Reset your ScamShield password",
      text: `Use this link to choose a new password:\n\n${this.options.publicAppUrl}/reset-password?token=${encodeURIComponent(token)}\n\nReset token: ${token}\n\nThis link expires in 30 minutes. If you did not request a reset, ignore this email; your password will not change.`,
    });
  }

  async resetPassword(token: string, newPassword: string) {
    const userId = await this.repos.tokens.consume("password_reset", hashToken(token));
    if (!userId) throw new AppError(400, "INVALID_TOKEN", "This reset link is invalid or has expired.");
    await this.repos.users.setPassword(userId, await hashPassword(newPassword));
    // Receiving the reset email proves control of the address.
    await this.repos.users.markVerified(userId);
    await this.repos.sessions.deleteAllForUser(userId);
  }

  async changePassword(ctx: AuthContext, currentPassword: string, newPassword: string) {
    await this.confirmPassword(ctx.user.id, currentPassword);
    await this.repos.users.setPassword(ctx.user.id, await hashPassword(newPassword));
    await this.repos.sessions.deleteAllForUser(ctx.user.id, ctx.sessionId);
  }

  async confirmPassword(userId: string, password: string) {
    const hash = await this.repos.users.getPasswordHash(userId);
    if (!hash || !(await verifyPassword(hash, password))) {
      throw new AppError(401, "INVALID_CREDENTIALS", "Your current password is incorrect.");
    }
  }

  async deleteAccount(ctx: AuthContext, password: string) {
    await this.confirmPassword(ctx.user.id, password);
    // ON DELETE CASCADE removes sessions, tokens, scans, and feedback.
    await this.repos.users.delete(ctx.user.id);
  }
}
