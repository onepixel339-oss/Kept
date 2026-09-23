/**
 * User module — the owner of this space.
 *
 * Owns real accounts, sessions, and the identity resolution every
 * other module relies on. Kept is a personal product: everything in
 * the database ultimately belongs to an authenticated account.
 *
 * Responsibilities:
 *  - Identity resolution — getCurrentUser / requireUser /
 *    requireCurrentUserId / requirePageUser (application/current-user.ts)
 *  - Account lifecycle — signup, sign-in, sign-out, password change,
 *    password reset (application/account.ts)
 *  - Data rights — export, account deletion, explicit legacy-data
 *    claim (application/data-rights.ts)
 *  - Validation — email/password schemas (application/validation.ts)
 *  - Infrastructure — scrypt hashing, token hashing, rate limiting
 *
 * Boundary rules:
 *  - Other modules never read cookies or sessions; they receive an
 *    explicit userId resolved here.
 *  - The provider (scrypt + session rows + cookies) lives under this
 *    module. Swapping it is a change inside this folder, nothing else.
 *  - No plaintext password is ever stored, logged, or returned. No
 *    session token is ever persisted in raw form.
 *
 * Depends on:
 *  - `@/lib/db` (persistence), `@/lib/identity` (legacy claim ticket)
 */

export * from "./application/current-user";
export * from "./application/account";
export * from "./application/data-rights";
export * from "./application/validation";
export { RATE_LIMITS } from "./infrastructure/rate-limit";
export type { RateLimitName } from "./infrastructure/rate-limit";
