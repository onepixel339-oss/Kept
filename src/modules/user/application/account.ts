/**
 * Account lifecycle — signup, sign-in, sign-out, password management.
 *
 * The authentication abstraction the application uses. Provider
 * specifics (scrypt hashing, session rows, cookies) live beneath
 * these functions; nothing else in the codebase knows how sessions
 * are implemented.
 *
 * Security posture (docs/security.md):
 *  - login responses are uniform — "no such account" and "wrong
 *    password" are the same error, at the same cost (a dummy scrypt
 *    verification equalizes timing)
 *  - signup conflict reveals that an email is registered. Without an
 *    email-verification flow (deferred) this is unavoidable for a
 *    working signup; documented honestly rather than hidden.
 *  - every authentication issues a FRESH session (rotation)
 *  - password changes invalidate every other session
 *  - rate limits apply per client key, declared in rate-limit.ts
 *  - no plaintext password is ever stored, logged, or returned
 */

import { db } from "@/lib/db";
import { AppError } from "@/lib/api";
import {
  createSession,
  invalidateAllSessions,
  invalidateSessionByToken,
  toPublicUser,
  type IssuedSession,
  type PublicUser,
} from "@/modules/user/application/current-user";
import {
  changePasswordSchema,
  loginSchema,
  resetConfirmSchema,
  resetRequestSchema,
  signupSchema,
  type ChangePasswordInput,
  type LoginInput,
  type ResetConfirmInput,
  type ResetRequestInput,
  type SignupInput,
} from "@/modules/user/application/validation";
import { checkRateLimit } from "@/modules/user/infrastructure/rate-limit";
import {
  dummyVerification,
  hashPassword,
  verifyPassword,
} from "@/modules/user/infrastructure/password";
import { generateToken, hashToken } from "@/modules/user/infrastructure/tokens";

export interface AuthOutcome {
  user: PublicUser;
  session: IssuedSession;
}

const UNIFORM_LOGIN_ERROR =
  "That email and password don't match an account.";

/* ————————————————— signup ————————————————— */

export async function signUp(input: unknown, clientKey: string): Promise<AuthOutcome> {
  const rl = checkRateLimit("signup", clientKey);
  if (!rl.allowed) {
    throw new AppError("rate_limited", "Too many attempts — try again in a while.");
  }

  const parsed = signupSchema.parse(input);

  const existing = await db.user.findUnique({ where: { email: parsed.email } });
  if (existing) {
    // Honest conflict: without an email-verification flow there is no
    // safe way to pretend the account was created. Never includes the
    // attempted password.
    throw new AppError(
      "conflict",
      "An account with this email already exists — you can sign in instead."
    );
  }

  const user = await db.user.create({
    data: {
      email: parsed.email,
      passwordHash: await hashPassword(parsed.password),
    },
  });

  const session = await createSession(user.id);
  return { user: toPublicUser(user), session };
}

/* ————————————————— sign in ————————————————— */

export async function signIn(input: unknown, clientKey: string): Promise<AuthOutcome> {
  const rl = checkRateLimit("login", clientKey);
  if (!rl.allowed) {
    throw new AppError("rate_limited", "Too many attempts — try again in a few minutes.");
  }

  const parsed = loginSchema.parse(input);

  const user = await db.user.findUnique({ where: { email: parsed.email } });
  if (!user) {
    // Same work, same words, same code — no enumeration.
    await dummyVerification(parsed.password);
    throw new AppError("unauthorized", UNIFORM_LOGIN_ERROR);
  }

  const valid = await verifyPassword(parsed.password, user.passwordHash);
  if (!valid) {
    throw new AppError("unauthorized", UNIFORM_LOGIN_ERROR);
  }

  const session = await createSession(user.id);
  return { user: toPublicUser(user), session };
}

/* ————————————————— sign out ————————————————— */

/** Logout truly invalidates the server-side session, not a client flag. */
export async function signOut(sessionToken: string | null | undefined): Promise<void> {
  await invalidateSessionByToken(sessionToken);
}

/* ————————————————— password change ————————————————— */

/**
 * Change the password of the signed-in account. Requires the current
 * password; every existing session is invalidated so a stolen session
 * cannot survive a recovery. The caller receives a FRESH session for
 * the current device (cookie rotation happens at the route).
 */
export async function changePassword(
  userId: string,
  input: unknown
): Promise<IssuedSession> {
  const parsed = changePasswordSchema.parse(input);
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user?.passwordHash) {
    throw new AppError("unauthorized", "Sign in again to change your password.");
  }

  const valid = await verifyPassword(parsed.currentPassword, user.passwordHash);
  if (!valid) {
    throw new AppError("unauthorized", "Your current password isn't right.");
  }

  await db.user.update({
    where: { id: userId },
    data: { passwordHash: await hashPassword(parsed.newPassword) },
  });
  await invalidateAllSessions(userId);
  return createSession(userId);
}

/* ————————————————— password reset ————————————————— */

/**
 * The delivery port. The only implementation that exists today is
 * NullDelivery: the token lifecycle is real, email delivery is an
 * explicitly DEFERRED integration (no mail service is configured in
 * this environment — see docs/security.md). Nothing here fakes
 * "email sent".
 */
export interface ResetTokenDelivery {
  deliver(email: string, token: string): Promise<void>;
}

export const nullDelivery: ResetTokenDelivery = {
  async deliver() {
    /* Deferred: no email provider is configured. Documented, honest. */
  },
};

const RESET_TOKEN_TTL_MS = 30 * 60 * 1000; // thirty minutes

export interface ResetRequestOutcome {
  /** Whether a reset token was created (an account with a password exists). */
  tokenCreated: boolean;
  /**
   * The raw token — returned ONLY to the immediate caller for
   * delivery. Route handlers hand it to the delivery port and never
   * to the HTTP client, never to a log.
   */
  token: string | null;
}

/**
 * Request a password reset. The HTTP response for "account exists"
 * and "no such account" is identical at the route layer (no
 * enumeration); internally a token is created only for real accounts
 * and handed to the delivery port.
 */
export async function requestPasswordReset(
  input: unknown,
  clientKey: string,
  delivery: ResetTokenDelivery = nullDelivery
): Promise<ResetRequestOutcome> {
  const rl = checkRateLimit("resetRequest", clientKey);
  if (!rl.allowed) {
    throw new AppError("rate_limited", "Too many requests — try again later.");
  }

  const parsed = resetRequestSchema.parse(input);
  const user = await db.user.findUnique({ where: { email: parsed.email } });

  if (!user || !user.passwordHash) {
    return { tokenCreated: false, token: null };
  }

  const token = generateToken();
  await db.passwordResetToken.create({
    data: {
      tokenHash: hashToken(token),
      userId: user.id,
      expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
    },
  });

  await delivery.deliver(user.email ?? parsed.email, token);
  return { tokenCreated: true, token };
}

/**
 * Complete a password reset with a valid, unexpired, unused token.
 * The token is single-use; every session of the account is
 * invalidated (a reset is a recovery event — start clean).
 */
export async function resetPassword(input: unknown): Promise<void> {
  const parsed = resetConfirmSchema.parse(input);

  const record = await db.passwordResetToken.findUnique({
    where: { tokenHash: hashToken(parsed.token) },
  });
  if (
    !record ||
    record.usedAt ||
    record.expiresAt.getTime() <= Date.now()
  ) {
    throw new AppError("validation_failed", "This reset link isn't valid anymore.");
  }

  await db.$transaction([
    db.user.update({
      where: { id: record.userId },
      data: { passwordHash: await hashPassword(parsed.newPassword) },
    }),
    db.passwordResetToken.update({
      where: { id: record.id },
      data: { usedAt: new Date() },
    }),
  ]);

  await invalidateAllSessions(record.userId);
}

/* ————————————————— session introspection (settings) ————————————————— */

/** Count of live sessions for the settings page. */
export async function countLiveSessions(userId: string): Promise<number> {
  return db.session.count({
    where: { userId, expiresAt: { gt: new Date() } },
  });
}

// Re-exports keep the module's public surface complete without
// exporting infrastructure files directly.
export type { ChangePasswordInput, LoginInput, SignupInput };
