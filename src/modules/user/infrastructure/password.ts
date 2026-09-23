/**
 * Password hashing — the only place plaintext passwords are ever held
 * in memory, and even here only momentarily.
 *
 * Mechanism: Node's built-in scrypt (memory-hard, designed for
 * passwords), a random 16-byte salt per hash, and a serialized format
 * that carries its own parameters:
 *
 *   scrypt$N$r$p$<salt base64>$<hash base64>
 *
 * Verification is constant-time (timingSafeEqual). Unknown-email
 * logins verify against a fixed dummy hash so "no such user" and
 * "wrong password" take comparable time — the response is identical
 * either way.
 *
 * Rules enforced here and everywhere else (docs/security.md):
 *   - never store plaintext passwords
 *   - never log passwords
 *   - never include password values in error messages
 */

import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem?: number }
) => Promise<Buffer>;

/** OWASP-aligned baseline for interactive authentication. */
const PARAMS = {
  N: 16_384,
  r: 8,
  p: 1,
  keylen: 64,
  maxmem: 64 * 1024 * 1024,
} as const;

const ALGORITHM = "scrypt";

/** A valid-format stand-in hash, used only to equalize login timing. */
const DUMMY_HASH = [
  ALGORITHM,
  PARAMS.N,
  PARAMS.r,
  PARAMS.p,
  Buffer.from("kept-dummy-salt-for-unknown-emails").toString("base64"),
  randomBytes(PARAMS.keylen).toString("base64"),
].join("$");

/** Hash a password. Returns the self-describing serialized form. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, PARAMS.keylen, {
    N: PARAMS.N,
    r: PARAMS.r,
    p: PARAMS.p,
    maxmem: PARAMS.maxmem,
  });
  return [
    ALGORITHM,
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString("base64"),
    derived.toString("base64"),
  ].join("$");
}

/**
 * Verify a password against a stored hash. Returns false for absent,
 * malformed, or differently-hashed values — never throws on bad input,
 * so a corrupt row can never crash the login path.
 */
export async function verifyPassword(
  password: string,
  storedHash: string | null | undefined
): Promise<boolean> {
  if (!storedHash) return false;
  const parts = storedHash.split("$");
  if (parts.length !== 6 || parts[0] !== ALGORITHM) return false;

  const [, nRaw, rRaw, pRaw, saltB64, hashB64] = parts;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) {
    return false;
  }

  try {
    const salt = Buffer.from(saltB64, "base64");
    const expected = Buffer.from(hashB64, "base64");
    const derived = await scrypt(password, salt, expected.length, {
      N,
      r,
      p,
      maxmem: PARAMS.maxmem,
    });
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/**
 * Burn one real scrypt verification for an unknown email so that
 * "no such account" costs the same as "wrong password".
 */
export async function dummyVerification(password: string): Promise<void> {
  await verifyPassword(password, DUMMY_HASH);
}
