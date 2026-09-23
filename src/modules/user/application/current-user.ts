/**
 * Current user — the seam between HTTP identity and domain ownership.
 *
 * Phase 7: identity is a REAL authenticated session. The cookie
 * carries a random bearer token; the database stores only its hash.
 * The signed anonymous identity cookie of Phases 2–6 (`kept_uid`) is
 * no longer an identity: it survives solely as a claim ticket that
 * lets a signed-in account explicitly import its old local data
 * (see application/account.ts — never a silent association).
 *
 * Resolution rules:
 *  - `getCurrentUser()` reads the session cookie, resolves the
 *    session (rejecting expired ones) and returns the account
 *    WITHOUT its password hash — or null. Safe in server components
 *    and route handlers. Creates nothing.
 *  - `requireUser()` is what protected API routes call; it throws
 *    401 rather than guessing.
 *  - `requireCurrentUserId()` remains the narrow id-only form used
 *    across the existing service call sites — same session underneath.
 *  - `requirePageUser()` redirects anonymous visitors to /login for
 *    server components.
 *
 * The authenticated session is the ONLY source of user identity.
 * Nothing here ever reads a user id from a body, query string, or
 * client state.
 */

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { AppError } from "@/lib/api";
import { hashToken, generateToken } from "@/modules/user/infrastructure/tokens";

export const SESSION_COOKIE = "kept_session";

/** Sessions last thirty quiet days, then genuinely expire. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** The account as the rest of the application may see it — never the hash. */
export interface PublicUser {
  id: string;
  email: string | null;
  name: string | null;
  createdAt: Date;
}

export function toPublicUser(user: {
  id: string;
  email: string | null;
  name: string | null;
  createdAt: Date;
}): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    createdAt: user.createdAt,
  };
}

/* ————————————————— sessions ————————————————— */

export interface IssuedSession {
  /** The raw token — goes into the cookie exactly once, never stored. */
  token: string;
  expiresAt: Date;
}

/**
 * Create a fresh session for an authenticated account. Called on
 * signup and login only — every authentication rotates the session.
 */
export async function createSession(userId: string): Promise<IssuedSession> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.session.create({
    data: { tokenHash: hashToken(token), userId, expiresAt },
  });
  // Housekeeping: a user's dead sessions have no reason to remain.
  await db.session.deleteMany({
    where: { userId, expiresAt: { lt: new Date() } },
  });
  return { token, expiresAt };
}

/** Resolve a bearer token to a live account. Expired ⇒ null. */
export async function resolveUserByToken(token: string | null | undefined): Promise<PublicUser | null> {
  if (!token) return null;
  const session = await db.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });
  if (!session) return null;
  if (session.expiresAt.getTime() <= Date.now()) {
    // Expired sessions are garbage, not credentials. Remove on sight.
    await db.session.delete({ where: { id: session.id } }).catch(() => undefined);
    return null;
  }
  return toPublicUser(session.user);
}

/** Invalidate one session (logout, session rotation after reset). */
export async function invalidateSessionByToken(token: string | null | undefined): Promise<void> {
  if (!token) return;
  await db.session.deleteMany({ where: { tokenHash: hashToken(token) } });
}

/** Invalidate every session an account holds (account deletion, password change). */
export async function invalidateAllSessions(userId: string): Promise<void> {
  await db.session.deleteMany({ where: { userId } });
}

/* ————————————————— cookie plumbing ————————————————— */

export interface SessionCookie {
  name: string;
  value: string;
  options: {
    httpOnly: true;
    sameSite: "lax";
    secure: boolean;
    path: "/";
    maxAge: number;
  };
}

/**
 * Cookie descriptor for a fresh session. HttpOnly (never readable
 * from JS), SameSite=Lax (cross-site posts carry no cookie — the
 * CSRF backbone), Secure in production, absolute maxAge.
 */
export function sessionCookie(token: string): SessionCookie {
  return {
    name: SESSION_COOKIE,
    value: token,
    options: {
      httpOnly: true as const,
      sameSite: "lax" as const,
      secure: process.env.NODE_ENV === "production",
      path: "/" as const,
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    },
  };
}

/** Cookie descriptor that removes the session cookie client-side. */
export function clearedSessionCookie(): SessionCookie {
  return {
    ...sessionCookie(""),
    options: { ...sessionCookie("").options, maxAge: 0 },
  };
}

/* ————————————————— HTTP resolution ————————————————— */

async function readSessionToken(): Promise<string | null> {
  const store = await cookies();
  return store.get(SESSION_COOKIE)?.value ?? null;
}

/** The current account, or null when anonymous. Never creates anything. */
export async function getCurrentUser(): Promise<PublicUser | null> {
  return resolveUserByToken(await readSessionToken());
}

/** The current account's id, or null. (Server components use this.) */
export async function resolveCurrentUserId(): Promise<string | null> {
  const user = await getCurrentUser();
  return user?.id ?? null;
}

/** Same as getCurrentUser, but 401s when there is no valid session. */
export async function requireUser(): Promise<PublicUser> {
  const user = await getCurrentUser();
  if (!user) {
    throw new AppError("unauthorized", "You need to sign in to do that.");
  }
  return user;
}

/** The narrow id-only form protected API routes have always called. */
export async function requireCurrentUserId(): Promise<string> {
  const user = await requireUser();
  return user.id;
}

/** For server components: anonymous visitors go calmly to /login. */
export async function requirePageUser(): Promise<PublicUser> {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }
  return user;
}
