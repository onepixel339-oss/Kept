/**
 * Legacy identity primitive — now a CLAIM TICKET, not an identity.
 *
 * Phases 2–6 used this signed anonymous cookie as the product's
 * identity mechanism. Phase 7 replaced it with real authentication
 * (sessions in the user module); this signed value survives for
 * exactly one purpose: letting a signed-in account EXPLICITLY import
 * the browser's pre-account local data (Settings → Data). It is
 * never consulted for authorization anymore.
 *
 * Properties:
 *  - The cookie value is `userId.signature`, signed with
 *    KEPT_IDENTITY_SECRET — it cannot be forged into another user's id.
 *  - Only anonymous rows (no email, no password) are claimable; a
 *    real account can never be attached to someone else by guessing ids.
 *  - Every service takes an explicit userId and scopes every query by
 *    it. Ownership is enforced independently of this file.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const IDENTITY_COOKIE = "kept_uid";

/**
 * Signing secret. Set KEPT_IDENTITY_SECRET in the environment.
 * The fallback exists for local development only and is deliberately
 * predictable — production deployments must provide a real secret.
 */
function secret(): string {
  return process.env.KEPT_IDENTITY_SECRET ?? "kept-development-identity-secret";
}

function sign(userId: string): string {
  return createHmac("sha256", secret()).update(userId).digest("hex").slice(0, 32);
}

/** Issue a tamper-proof cookie value for a user id. */
export function issueIdentityValue(userId: string): string {
  return `${userId}.${sign(userId)}`;
}

/**
 * Verify a cookie value and return the user id, or null when the value
 * is absent, malformed, or forged.
 */
export function verifyIdentityValue(value: string | undefined | null): string | null {
  if (!value) return null;
  const dot = value.indexOf(".");
  if (dot <= 0) return null;
  const userId = value.slice(0, dot);
  const signature = value.slice(dot + 1);
  const expected = sign(userId);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return userId;
}
