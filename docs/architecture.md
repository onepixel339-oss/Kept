# Kept — Architecture

This document is the structural law of the project. When code and this
document disagree, either the code is wrong or the document is outdated —
fix one of them immediately. Future agents: read this file fully before
writing code, and update it as part of any structural change.

## 1. The shape: a modular monolith

Kept is a **modular monolith**. One deployable Next.js application, one
database, organized internally into modules with explicit boundaries.

Microservices are forbidden. The product is personal, single-tenant, and
operated by one person; the operational cost of distributed systems buys
nothing here, while clear internal boundaries buy everything. If a future
requirement seems to demand a separate service, the correct first move is
to strengthen the module boundary — not to split the deployment.

The runtime flow, top to bottom:

```
Frontend (Next.js App Router, React Server Components + client islands)
        ↓
API layer (route handlers; thin: identity + envelope, no business logic)
        ↓
Application services (modules/*/application — use cases, zod validation)
        ↓                                     ↘
Domain logic (modules/*/domain — pure rules)    AI Gateway (src/lib/ai)
        ↓                                     ↙   proposals only, never writes
Repositories (modules/*/infrastructure — the only place Prisma appears)
        ↓
Database (SQLite now; PostgreSQL is the target — see docs/memory-system.md §9)
```

The Memory Orchestrator arrived in Phase 3 as the intelligence
pipeline (`modules/intelligence`): it composes the memory and entity
services with the AI Gateway and persists ONLY through their public
APIs. The Query Orchestrator arrived in Phase 4
(`modules/query/application/orchestrator.ts`): it composes the same
services with the planner and retrievers and is READ-ONLY — retrieval
never writes. The reasoning layer arrived in Phase 5
(`modules/reasoning`): it consumes the ContextPack the query module
produces and proposes grounded answers through the gateway — the
grounding pass and the bounded verification loop decide what the user
reads; the reasoning layer never retrieves and never writes.

## 2. Architectural principles

### 2.1 The AI never touches the database

This is the single most important rule in the codebase.

AI proposes structured information. Application logic validates and
decides. The database persists. Concretely:

- AI providers receive plain content — never database models, never
  connection objects, never SQL.
- AI providers return raw output that becomes a proposal only after
  application validation (`modules/intelligence/domain/ai-schemas.ts`,
  zod). A proposal that fails validation is a recorded, safe failure —
  never a partial write.
- Only `modules/memory` and `modules/entity` write their own data. The
  intelligence pipeline persists approved changes exclusively through
  their public APIs — ownership checks stay enforced on every path.
- The AI gateway (`src/lib/ai`) is the only code allowed to construct
  AI requests, and the ONLY code allowed to import the z.ai SDK.
  Modules import the gateway; the gateway imports nothing from
  modules.
- The model can only reference ids that were in its context; the
  decision engine discards anything else before deciding.

Dependency direction is one-way, downward: `modules → lib/ai`, never
`lib/ai → modules`.

### 2.2 Original content is immutable

`Memory.originalContent` is the user's words, preserved verbatim forever.
It is never replaced by a summary or any generated text. Meaningful edits
append versions (`memory_versions`) capturing each new state; the original
and every intermediate state remain retrievable. Updates must never
silently discard history.

### 2.3 Honest software

No fake functionality, no mock AI behavior, no placeholder backend
actions that pretend to succeed. A feature that does not exist is either
absent from the interface or explicitly marked as arriving later
(`enabled: false` navigation is the established pattern). When AI is
unconfigured, the system fails honestly — it never silently mocks.

### 2.4 Thin API, fat domain

Route handlers validate input shape and delegate. Business rules,
validation of AI proposals, and persistence decisions live in modules.
A route handler that contains an `if` about domain meaning is a smell.

### 2.5 Server by default

React Server Components are the default; `'use client'` is an island
exception justified by interactivity (inputs, toggles, motion). Data
fetching happens on the server; the client receives composed UI.

## 3. Repository layout

```
src/
  app/                  # Next.js App Router: routes, layouts, error/404
  components/
    ui/                 # shadcn/ui primitives (foundation — heavily customized at usage)
    layout/             # shell: masthead, footer, navigation, theme
    brand/              # wordmark and identity
    home/               # home-page composition (memory input, etc.)
    auth/               # Phase 7: auth shell, login/signup forms
    settings/           # Phase 7: account controls (password, sign-out),
                        #   data controls (export, claim, deletion)
    shared/             # cross-page design-system components (states, labels)
  modules/              # domain modules — see §4
    memory/             # domain/ · application/ · infrastructure/
    entity/             # domain/ · application/ · infrastructure/
    intelligence/       # Phase 3: pipeline, decision engine, entity
                        #   resolution, processing state, provenance
    query/              # Phase 4: query understanding, planner,
                        #   retrievers, merge/rank, context builder;
                        #   Phase 5: ask pipeline + intent routing
    reasoning/          # Phase 5: grounded answers, deterministic
                        #   grounding, bounded verification loop,
                        #   honest no-evidence behavior
    exploration/        # Phase 6: People/Topics/Timeline data —
                        #   deterministic derivations (application
                        #   only; no AI, no infrastructure)
    conversation/       # Phase 4: chat_messages persistence (bounded,
                        #   honest context records)
    user/               # Phase 7: accounts, sessions, identity
                        #   resolution, password lifecycle, data rights
                        #   (export / deletion / explicit legacy claim)
    ingestion/          # Phase 9: rich input — extractors (image, audio,
                        #   document, URL), normalized ingestion, source
                        #   provenance reads, idempotent retry; converges
                        #   into the ONE memory pipeline
  lib/
    db.ts               # Prisma client singleton
    ai/                 # AI gateway: contracts, z.ai provider, prompt
                        #   composition, embedding seam (deferred, honest);
                        #   Phase 9: vision + transcription + page-reader
                        #   contracts (capability-gated, probe-verified)
    storage/            # Phase 9: StorageProvider seam + local adapter —
                        #   opaque keys, traversal-safe, private by default
    identity.ts         # legacy signed-cookie primitive — now ONLY the
                        #   claim ticket for pre-account local data
    api.ts              # AppError + ApiResult envelope + handler wrapper
                        #   (+ same-origin check, trimmed error logging)
    format.ts           # editorial date/snippet formatting
    entity-links.ts     # the one entity → route mapping (people /
                        #   topics pages, search fallback)
    utils.ts            # cn() and small shared helpers
  types/                # shared domain + API contract types
  config/               # product config, navigation, intelligence gates
  prompts/              # prompt assets (versioned; memory-analysis/v1,
                        #   memory-comparison/v1, query-understanding/v1,
                        #   answer-generation/v1, answer-verification/v1)
  hooks/                # shared React hooks
docs/                   # source of truth: product, architecture, design, memory-system
prisma/                 # schema (snake_case-mapped; PostgreSQL-portable)
db/                     # SQLite database files (custom.db = dev, test.db = tests)
tests/                  # vitest suites (Memory Core) + scaffold scripts (see §7)
```

## 4. Module responsibilities

Modules are the unit of ownership. Each module's `index.ts` documents its
contract; the rule is **exported API or nothing** — other modules consume
a module only through its public surface, never by reaching into its
files or the database directly.

| Module | Owns | May depend on | Never does |
|--------|------|---------------|------------|
| `memory` | Lifecycle of memories: capture, storage, revision, versioning, recall, processing-state surface | `lib/db`, `lib/ai` (types only), `types` | Another module's internals; entity/graph writes |
| `entity` | Entities, canonical identity, memory↔entity links, the relation graph, candidate pools for resolution | `memory` (public API), `lib/db`, `lib/ai` (types only) | Writing memories directly |
| `intelligence` | The processing pipeline: analysis validation, entity resolution, decision engine, enrichment/state application, processing provenance | `memory`, `entity` (public APIs), `lib/ai`, `lib/db` (own analyses table only) | Writing memories/entities/relations except through their public APIs; any Phase 4 retrieval/chat behavior |
| `query` | Query understanding (AI proposal + deterministic fallback), the Query Planner, retrievers (structured/keyword/entity/temporal/graph/semantic — semantic real-but-gated), merge, ranking, context building, search, the ask pipeline and its explicit chat-intent routing (capture/deletion/count) | `memory`, `entity`, `conversation`, `reasoning` (public APIs), `lib/ai` | Writing memories except through `memory`'s public APIs on explicit user words; bypassing the planner; calling providers directly |
| `reasoning` | The final layer: answer/verification proposal schemas (zod), deterministic grounding (fabricated provenance discarded), the bounded verification loop, honest no-evidence/partial/failure behavior, deterministic answer lines | `lib/ai` (gateway only), shared query types | Retrieving anything (it sees only the pack it is handed); writing to the database; letting raw model output reach the user |
| `conversation` | `chat_messages`: the user's questions and the assistant's honest context records; bounded conversation windows | `lib/db`, `config/query` | Inventing content not grounded in retrieval; unbounded history reads |
| `exploration` | The People / Topics / Timeline surfaces: indexes, entity detail data, the global timeline, similar memories, the discovery strip — all deterministic derivations through `memory`/`entity` public APIs | `memory`, `entity` (public APIs only) | Any AI call; its own Prisma (application-only module); new retrieval engines; fabricating or proxying dates onto surfaces |
| `user` | Real accounts and identity: signup/login/logout, scrypt password hashing, session lifecycle (rotation, expiry, invalidation), rate limiting, password reset (delivery deferred), export, transactional account deletion, the explicit legacy-data claim | `lib/db`, `lib/identity` (claim ticket only) | Trusting any identity source other than the session cookie; logging or returning credentials; touching other modules' domain logic |
| `ingestion` | Rich input (Phase 9): modality extractors (image via vision, audio via ASR, documents locally, URLs behind full SSRF protection), the normalized ingestion result, source provenance reads, idempotent retry, storage-backed preservation of originals | `memory` (public API: createMemoryWithSources), `lib/ai` (gateway), `lib/storage`, `lib/db` (own source reads only) | Creating memories except through `memory`'s public APIs; parsing anything in the memory module's domain; fabricating an extraction when a capability is unavailable |

Since Phase 2, `memory` and `entity` expose real public APIs
(CRUD, versioning, linking, relation creation — see
`docs/memory-system.md` §7). Since Phase 3, `intelligence` composes
them. Since Phase 4, `query` composes them too — read-only, with
additive retrieval helpers (`getMemoriesByIds`, `listMemoriesInWindow`,
batched graph adjacency). Since Phase 5, `query` composes `reasoning`
(the ContextPack → answer step; see `docs/reasoning-system.md`) and
routes the user's EXPLICIT chat intents through `memory`'s public APIs
(capture → `createMemory` + the orchestrator scheduled by the route;
unambiguous deletion → the existing `deleteMemory` flow). Since
Phase 6, `exploration` composes the same two modules additively —
application-only, purely deterministic, read-only (counts, timeline,
co-occurrence derivations; see `docs/exploration-system.md`).
Phase 7 made `user` the identity foundation everything stands on:
route handlers resolve the session through `user` and pass an explicit
userId downward; no other module reads cookies, sessions, or
credentials (see `docs/security.md`). Phase 9 added `ingestion`:
every rich input direction converges into its ONE normalized pipeline
and then flows into the same Memory Orchestrator — creation goes only
through `memory`'s public API (`createMemoryWithSources`), so there is
no second memory system (see `docs/ingestion-system.md`).
Dependency direction stays one-way:
`query → memory/entity/conversation/reasoning → lib/*`,
`exploration → memory/entity → lib/*`,
`ingestion → memory → lib/*`, and
`everything → user (identity) → lib/db`.

## 5. The AI gateway

`src/lib/ai` is the seam and the only door: `MemoryIntelligenceProvider`
(`analyzeMemory`, `compareMemories`, optional `embed`, optional
`understandQuery`, optional `generateAnswer`, optional `verifyAnswer`,
and Phase 9's optional `extractImage` / `transcribe` / `readPage` —
each behind a static capability flag: `embeds`, `visions`,
`transcribes`, `readsPages`),
the gateway (`getAiGateway()`), and the z.ai
development provider (`providers/zai.ts` — the only file that imports
the SDK, backend only). The Phase 1 `MemoryUnderstandingProvider`
contract is preserved for compatibility. Providers return RAW output;
the owning module's zod schemas make it trustworthy; application logic
decides. Query understanding follows the same law: the query module
validates proposals (`modules/query/domain/understanding.ts`) and any
failure falls back to the deterministic understanding — retrieval is
never blocked by the model, and a mention's AI-proposed entity id is a
hint that gets validated against the user's known entities, never a
decision (it cannot resolve ambiguity, and foreign ids are stripped).
Grounded answers follow the same law one layer up: the reasoning
module validates proposals (`modules/reasoning/domain/answer-schemas.ts`),
grounds every claim deterministically against the ContextPack, and the
bounded verification loop — never the model — decides what the user
finally reads (see `docs/reasoning-system.md`).

- Provider selection comes from `AI_PROVIDER` (default `zai`);
  `AI_API_KEY` remains reserved. Missing configuration fails honestly
  — no mock responses.
- Tests inject fixture providers through the pipeline
  (`processMemory(memory, { provider })`); the suite never touches the
  network.
- Prompt text lives only in `src/prompts/**` as versioned, immutable
  assets; the gateway composes them with structured inputs.
- The embedding seam (`lib/ai`) is now REAL end to end (Phase 8): the
  provider contract with model/version metadata, the honest capability
  gate (`embeddingCapability()`), and a genuine SQLite vector
  repository (`sqlite-embeddings.ts` — Float32 storage, cosine search,
  structural ownership). Production still never generates a vector —
  the installed z.ai SDK has no embedding API, so the gate closes and
  the deferral is reported honestly. Full documentation:
  `docs/semantic-memory.md`. Nothing fakes a vector.

## 6. Database

Prisma over SQLite (`db/custom.db`) today; **PostgreSQL is the target**
and the schema was built to make that a migration, not a redesign —
snake_case-mapped schema matching `docs/memory-system.md` exactly,
app-side enum validation, JSON-as-string in `sources.metadata`.
Models now: `users`, `memories` (with `processing_status`,
`embedding_status`), `memory_versions`, `entities`,
`memory_entities`, `relations`, `sources` (Phase 9: extraction
status, storage key, dedup key), `memory_sources` (Phase 9: the
many-to-many provenance join), `memory_analyses`,
`memory_embeddings`, `chat_messages`, `sessions`,
`password_reset_tokens`. The Phase 3, 4, 8, and 9 schema changes were
purely
additive — no destructive migration was run or needed. Ownership is
structural: every domain row carries `user_id` and every repository
query scopes by it. Schema changes go through `bun run db:push` in
this environment; the test database (`db/test.db`) is pushed by the
test suite's global setup — never reset destructively by hand.

## 7. Verification culture

Before any phase is considered done:

1. `bunx tsc --noEmit` — type safety is not optional.
2. `bun run lint` — the project lints clean.
3. `bun run test` — the vitest suites pass against a real database:
   Memory Core (`memory-core`, `memory-rules`), Memory Intelligence
   (`memory-intelligence`, `ai-contracts`), Query & Retrieval
   (`query-retrieval`, `query-pipeline`), and Reasoning & Chat
   (`reasoning-chat`). The AI-dependent suites use scripted fixtures —
   they never call the network.
4. The dev server (`bun run dev`, port 3000) renders without runtime
   errors — check `dev.log`.
5. Core interactions are verified in a real browser, not just compiled.

The shell scripts in `tests/` (`*.sh`) are environment/scaffold
verification scripts from the original scaffold — not product tests.
Product tests live in `tests/**/*.test.ts` (vitest; files run
sequentially against the dedicated test database).

## 8. Rules for future agents (binding)

1. **Read the docs first.** `docs/product.md`, this file, and
   `docs/design-system.md` are the source of truth. Do not re-derive
   decisions that are already written down.
2. **Respect phase boundaries.** Do not implement ahead of the current
   phase. Unrequested features are defects, even good ones.
3. **Keep the AI in its lane.** No AI code outside `lib/ai`; no AI
   writes to the database, ever. All AI output is raw until the
   intelligence module's zod schemas accept it, and the decision
   engine — never the model — chooses what happens.
4. **Preserve original content.** Any change that would discard or alter
   `Memory.originalContent` is wrong by definition.
5. **Stay warm.** Design tokens come from `globals.css`; the palette is
   warm (no pure grays, no blue/indigo), clay is an accent, and the
   identity is editorial. See `docs/design-system.md`.
6. **One route at a time, fully real.** Every shipped route is complete,
   honest, and verified in the browser. Disabled areas use the
   `enabled: false` navigation pattern.
7. **Delete scaffold, not foundations.** Demo code may be removed freely
   (it was); documented contracts may not be removed without updating
   this document in the same change.
8. **Typecheck, lint, verify — every time.** A phase is not done because
   it compiles; it is done because it is verified.
9. **The planner is never bypassed.** There is no code path from a raw
   question straight to the database: questions are understood,
   planned, and retrieved through the query module. Retrieval is
   user-scoped by construction, read-only, and bounded — budgets in
   `config/query.ts` are not suggestions.
10. **No fake semantic search.** Embeddings are deferred; the system
   says so and continues with structured/keyword/entity/temporal/graph
   retrieval. When pgvector lands, `SemanticRetriever` becomes real
   behind the same interface — never before.
11. **The reasoning model never retrieves and never writes.** It sees
   only the ContextPack it was handed; if the pack is missing
   something, the answer says so. Every claim is grounded
deterministically (fabricated provenance discarded); the verification
   loop regenerates at most once; a conservative composition or an
   honest line — never a fabricated answer — is the fallback.
12. **The model never mutates memory.** Capture and deletion from chat
   run only on deterministic detection of the user's explicit words,
   through the memory module's public APIs (and the deletion only
   when the target is unambiguous). No AI decision can create, change,
   or destroy a memory.
13. **Exploration never invents.** The People/Topics/Timeline surfaces
   derive everything through deterministic database queries — counts
   are aggregates, suggestions name the entities they share, and only
   KNOWN event dates reach the timeline (undated memories are counted,
   never placed with a proxy or fabricated date). Exploration composes
   public APIs only, adds no REST endpoints without need, and never
   becomes a dashboard: descriptive, bounded, quiet.
14. **Identity comes from the session, and from nothing else.** Every
   protected route and page resolves the authenticated user through
   the user module; no `user_id` from a body, query string, or client
   state is ever trusted. Ownership is always resource id + session
   user, cross-user ids look exactly like missing ones (404), no
   credential is ever logged, and legacy anonymous data reaches an
   account only through the explicit claim — never silently.
