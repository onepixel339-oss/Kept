/**
 * Token primitives for sessions and password-reset tokens.
 *
 * The bearer token is 32 random bytes, base64url-encoded. Only its
 * SHA-256 hash is persisted, so neither the database nor a log can be
 * replayed into a session. Lookup is by hash with a unique index —
 * one comparison, constant work.
 */

import { createHash, randomBytes } from "node:crypto";

/** Generate a new bearer token (the value that travels in the cookie). */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/** The persisted form of a token. Never store or log the raw token. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
