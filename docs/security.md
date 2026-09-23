# Kept — Security

This document describes how authentication, authorization, sessions,
and abuse protection actually work, as built in Phase 7. It is the
source of truth for security behavior; `tests/auth-security.test.ts`
verifies most of the sentences below directly.

## 1. Identity model

- A real account owns data. Identity is an authenticated **session**,
  resolved server-side from an HttpOnly cookie. Nothing else counts:
  no `user_id` from a body, query string, browser state, or header is
  ever trusted — the session is the only source of identity.
- The signed anonymous cookie of Phases 2–6 (`kept_uid`) is **no
  longer an identity**. It survives only as a claim ticket that lets
  a signed-in account explicitly import the browser's pre-account
  local data (§7). It is never consulted for authorization.
- Legacy anonymous rows (no email, no password) remain development
  data. They are never silently attached to an account — the claim
  flow is the only door, and the user presses it on purpose.

## 2. Authentication architecture

Provider specifics live entirely inside `src/modules/user`. The rest
of the application calls the abstraction:
`getCurrentUser()` / `requireUser()` / `requireCurrentUserId()` /
`requirePageUser()`, plus the account services (`signUp`, `signIn`,
`signOut`, `changePassword`, `requestPasswordReset`, `resetPassword`)
and the data-rights services (`exportUserData`, `deleteAccount`,
`claimLocalIdentity`). Swapping the provider means rewriting this
module, not the codebase.

Chosen implementation — deliberately dependency-free:

- **Passwords**: scrypt (memory-hard, Node built-in), random 16-byte
  salt per hash, self-describing serialized format
  (`scrypt$N$r$p$salt$hash`), constant-time comparison. Password
  policy: minimum 8 characters, maximum 200 — length over composition
  theater.
- **Tokens**: 32 random bytes, base64url; only the SHA-256 hash is
  stored (`sessions.token_hash`, `password_reset_tokens.token_hash`).
  A database leak yields no usable credentials.
- **No plaintext password** is ever stored, logged, returned, or
  included in an error message. No raw token is ever logged.

## 3. Session model

- Cookie: `kept_session` — HttpOnly (invisible to JavaScript),
  SameSite=Lax (cross-site posts carry no cookie — the CSRF
  backbone), Secure in production, Path=/, 30-day maxAge.
- **Rotation**: every signup and login creates a FRESH session row and
  cookie; sessions are never reused across authentications.
- **Expiration**: absolute 30-day lifetime; expired sessions are
  rejected on sight and deleted lazily (and swept on login).
- **Invalidation**: logout deletes the session row server-side (not a
  client flag). Password change invalidates every existing session and
  issues one fresh session for the current device. Account deletion
  destroys every session by cascade.
- Multiple devices may hold independent sessions; Settings shows the
  live count ("Active sign-ins").

## 4. Login security

- Uniform errors: unknown email and wrong password produce the same
  message, the same 401 code, and comparable cost — unknown-email
  logins run one real scrypt verification against a fixed dummy hash
  so timing reveals nothing.
- Signup duplicate-email answers 409 with a human message. This does
  reveal that an email is registered; without an email-verification
  flow (deferred, see §8) a working signup cannot avoid it. Documented
  honestly rather than hidden behind a fake "check your inbox".
- No CAPTCHA, no lockout-theatrics: the rate limit below is the abuse
  control, matching the single-tenant scale of the product.

## 5. Authorization & ownership

- Authentication answers "who is this?" (`requireUser`); authorization
  is structural: **every** service takes an explicit `userId` and
  scopes every query by it. There is no lookup-by-id-only path for
  user-owned data — resource id + owner id is the only key.
- Cross-user ids are indistinguishable from missing ones (404, not
  403) — ownership never leaks existence. Verified for memories,
  versions, entities, relations, graph traversal, conversations, and
  processing retries.
- `createMemory` and every other service validates input with zod,
  which strips unknown keys — a spoofed `userId` in a request body
  cannot influence ownership (tested).
- Protected pages call `requirePageUser()` and redirect anonymous
  visitors to `/login`. Protected API routes call
  `requireCurrentUserId()` / `requireUser()` and answer 401.

## 6. Data export

- `GET /api/export` (authenticated, rate-limited) returns the
  account's complete records as JSON: memories (with full version
  history), entities, memory↔entity links, relations, sources, and
  chat conversations. Content-Disposition attachment.
- Deliberately excluded: password hashes, sessions, reset tokens, and
  `memory_analyses` (internal processing machinery — recomputable,
  never part of the memory itself). Internal prompts, provider
  identities, and server diagnostics never leave the server.

## 7. Account deletion & the legacy claim

- **Deletion** (`DELETE /api/account`): authenticated session →
  password confirmation → one transaction deleting the account row;
  database cascades carry memories, versions, entities, links,
  relations, sources, chats, analyses, sessions, and reset tokens.
  A post-delete assertion verifies the account (and its sessions) are
  truly gone — partial or silent deletion cannot pass. Shared or
  global data does not exist in the schema; everything is user-scoped.
- **Claim** (`POST /api/account/claim`): the explicit import for
  pre-account browsers. The legacy `kept_uid` cookie must be validly
  signed AND point to an anonymous row (no email, no password) — a
  real account can never be claimed, a forged ticket is nothing. The
  migration is transactional: colliding entities merge into the
  target's existing entity (links and relations repointed, exact
  relation duplicates removed), ids stay stable so versions and links
  follow, the legacy row is deleted, and the ticket cookie is cleared
  in the same response — one shot. Settings shows the import card only
  when a valid ticket is present.

## 8. Password reset

The token lifecycle is real and tested: request → 30-minute single-use
token (hashed at rest) → confirm → password changed + every session
invalidated. What is explicitly **deferred** is email delivery: no
mail provider is configured in this environment, so the delivery port
exists behind an interface (`ResetTokenDelivery`) and its current
implementation delivers nowhere. Nothing fakes "email sent": the
request endpoint answers the same neutral message regardless of
whether an account exists, and no token is created that cannot be
delivered. Users recover access through Settings → Security (signed
in) or the operator's standard database care.

## 9. Rate limiting & abuse protection

- Declared in one table (`modules/user/infrastructure/rate-limit.ts`),
  applied through one helper, sliding in-process window, per-client or
  per-user keys: login 10/5min, signup 10/h, reset-request 5/h, chat
  30/5min, memory processing 20/5min, memory creation 40/5min, export
  10/h, and Phase 9 rich ingestion 30/5min (uploads, OCR/vision,
  transcription, and URL fetches are expensive; retries ride the
  existing `process` rule — no new rate-limit system was added).
- Honest limitation, documented: the window is per server **process**.
  The current deployment is a single Node process, so per-process
  equals per-server. If the deployment ever becomes multi-process,
  the store must move behind the same two functions (check/reset) —
  the implementation is replaceable by design.
- Abuse surface is otherwise bounded by existing Phase 3–5 guards:
  idempotent processing, single-run locks, bounded retrieval budgets,
  and request-size limits on every route's zod schema.
- CSRF: SameSite=Lax keeps the session cookie out of cross-site
  requests; `apiHandler` additionally verifies the Origin header on
  state-changing requests when the client declares one. No-token
  cookie design means no CSRF-token machinery was needed — that is a
  deliberate simplification, not an omission.

## 10. Transport & headers

`next.config.ts` sets, on every route:

- `Content-Security-Policy`: same-origin default; `script-src` and
  `style-src` need `'unsafe-inline'` (and dev needs `'unsafe-eval'`)
  because Next.js injects nonce-less bootstrap/style tags in this
  setup. Chosen deliberately over a stricter policy that would break
  the app; if a nonce-based middleware is added later, the policy can
  tighten without code changes elsewhere.
- `X-Frame-Options: DENY` + CSP `frame-ancestors 'none'` (no framing),
  `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`,
  `Permissions-Policy` denying camera/microphone/geolocation.

## 11. Logging policy

- Never logged: passwords, session tokens, cookies, reset tokens, or
  private memory content. Auth modules write no logs at all (a source
  scan test enforces this).
- `db.ts` no longer enables Prisma query logging (parameters can echo
  password hashes and memory content into logs). Enable temporarily
  with `KEPT_DEBUG_DB=1` when a specific query must be inspected.
- The API handler logs unexpected errors in trimmed form
  (`Name: message[:300]`), never full error objects (which can embed
  request parameters), and never surfaces internals to clients.
- Preferred log content: operation, duration, status, error code.

## 12. AI data boundary

The AI system receives the minimum context needed for the operation:
the memory being processed, or the ContextPack the question retrieved.
Never another account's data, never unrelated bulk dumps, never
credentials, session data, or internal security data. The ContextPack
strategy (Phase 4/5) remains the enforced boundary; Phase 7 added
authentication on top of it without changing it.

Phase 8 (embeddings) inherits every rule above:

- **Embeddings are private, user-owned data.** A vector is derived
  from a personal memory, so it is treated exactly like the memory
  itself: stored in the user's own database, deleted with the memory
  (FK cascade + explicit delete), and reachable only through
  ownership-joined reads. Cross-user semantic search is structurally
  impossible — the repository's search joins through
  `memories.user_id` (tested at repository and retriever level).
- **No logging of memory text during embedding.** Embedding logs carry
  duration, memory id, model, version, dimensions, and outcome only.
- **Query embeddings are transient** — a question's vector is never
  persisted, never stored as a memory.
- **No client-side provider access, no user API keys** — the gateway
  remains the only door; the free-product rule is unchanged.
- **No fabricated vectors**: with no embedding provider available,
  production stores and searches nothing; the honest deferral is the
  security-relevant behavior (nothing derived from private text ever
  exists to leak). See `docs/semantic-memory.md` §11.

Phase 9 (rich input) extends the boundary with its own rules:

- **Uploads never trust the client.** MIME types and extensions are
  hints; content signatures (magic bytes) and real decodes decide what
  a file is. Size caps are enforced from the Content-Length header
  before the body is parsed, then again inside every extractor. No
  upload is ever executed or served as executable content, and
  user-controlled filenames never become storage paths (keys are
  generated server-side; every storage operation re-validates keys
  against traversal).
- **Stored originals are private by default.** They live outside the
  web root behind a `StorageProvider` seam, and stream only through
  the authenticated, ownership-checked `/api/sources/:id/file` route
  (`private, no-store`, `nosniff`, no path or key exposure). Cross-user
  file requests look like missing sources.
- **URL ingestion is SSRF-hardened.** Only http/https on standard
  ports; DNS resolution checks EVERY record against loopback, private,
  link-local (including cloud metadata endpoints), CGNAT, and reserved
  ranges — both IP literals and hostnames; redirects are followed
  manually and every hop re-passes the full validation; requests are
  timeout- and size-bounded; the HTML parser never executes anything.
  Private addresses never reach any external service either — hosted
  page reading happens only after the same validation.
- **Vision and transcription see only user-owned bytes.** An image or
  a recording is sent to the provider (through the gateway, as a data
  URI) only when its owner initiates the keep; transcripts and OCR
  text are stored as the user's own content and inherit every
  ownership rule above. Capability unavailability is reported
  honestly (`pending`) — nothing is fabricated to fill the gap.
- **No secrets in logs**: extraction logs carry ids, states, and
  durations — never memory text, file contents, or provider internals.

## 13. Development mode

- No backdoors: no hardcoded passwords, no universal test
  credentials, no secret bypass cookies, no hidden admin accounts.
- The test suite uses isolated accounts in a dedicated SQLite database
  (`db/test.db`); rate limits reset between tests through the module's
  own helper.
- The synthetic legacy row used to verify the claim flow in the
  browser is clearly disposable test data; real pre-account development
  data stays untouched until its owner explicitly claims it.
