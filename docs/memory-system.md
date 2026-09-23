# Kept — Memory System

> Phase 2 stores and manages memory. Phase 3 adds Memory Intelligence:
> the pipeline that understands, connects, and maintains what was
> stored — with the AI strictly as a proposal engine. Phase 4 (query,
> retrieval, chat) is intentionally not started.

This document describes the Memory Core and the Intelligence layer:
the data models, ownership rules, versioning behavior, graph
foundation, the processing pipeline, and the boundaries that every
later phase must respect. When code and this document disagree, fix
one of them in the same change.

## 1. Responsibilities

The Memory Core is the only place where memories are created, mutated,
or interpreted. It provides:

- **Memory lifecycle** — create, read, list, update, delete
- **Versioning** — every meaningful edit preserves history
- **Entities** — reusable people, places, organizations, projects,
  topics, objects
- **Memory ↔ entity links** — explicit, role-bearing connections
- **Relations** — the graph foundation (memory↔memory, memory↔entity,
  entity↔entity), storage and safe creation only
- **Sources** — provenance: where each memory came from
- **Ownership** — every record is scoped to exactly one user, enforced
  by construction

Since Phase 3, the **Intelligence module** (`src/modules/intelligence`)
composes the Memory Core, the Entity module, and the AI gateway to
provide:

- **Processing state** — every memory honestly reports whether it has
  been understood (`pending → processing → ready | failed`)
- **Analysis** — validated structured understanding of each memory
- **Entity resolution** — deterministic-first matching that never
  silently merges an ambiguity
- **Comparison & decisions** — CREATE / UPDATE / MERGE / LINK /
  CONFLICT / IGNORE, chosen by deterministic rules over AI evidence
- **Provenance** — every processing attempt is recorded
  (`memory_analyses`), replaceable and recomputable

What it deliberately does NOT do yet: embeddings, semantic search,
graph traversal, query planning, conversational Ask, timeline
reflection, or anything that pretends to know more than the user
wrote.

## 2. Architecture in one view

```
Frontend (RSC + client islands)
        ↓
API routes (src/app/api/**)         ← validation, identity, error envelope
        ↓
Application services                ← use cases: modules/*/application
        ↓                                     ↘
Domain rules (pure)                 ← modules/*/domain   AI Gateway (lib/ai)
        ↓                                     ↙            proposals only
Repositories (Prisma)               ← modules/*/infrastructure
        ↓
SQLite (now) → PostgreSQL (target)
```

Phase 3 wired the seam exactly as designed: **Application Service
(intelligence pipeline) → AI Gateway (`src/lib/ai`) → raw proposal →
zod validation → deterministic decision → public APIs of memory/entity
persist approved changes.** The AI never writes to the database
directly, and no AI code exists anywhere except `lib/ai`.

## 3. Data models

### users

The owner of everything. `users` rows are created by identity
provisioning (see §8). Every personal-memory record carries a
`user_id` — there are no orphan records by design.

### memories

| Column | Type | Notes |
|---|---|---|
| `id` | string (cuid) | |
| `user_id` | string, required | owner; FK → users, cascade |
| `title` | string, nullable | deterministic default at creation, user-editable |
| `original_content` | string, required | **the user's own words, verbatim, forever** |
| `summary` | string, nullable | null until real understanding exists |
| `memory_type` | string | controlled vocabulary, default `note` |
| `importance` | float 0–1, default 0.5 | a proposal; the user has the final say |
| `confidence` | float 0–1, nullable | null until real understanding exists |
| `status` | string | `active` \| `archived` \| `superseded` |
| `remembered_at` | datetime, nullable | when the thing happened, not when it was written |
| `processing_status` | string, default `pending` | `pending` \| `processing` \| `ready` \| `failed` — pipeline state, never lifecycle |
| `processing_error` | string, nullable | stable, human-safe reason when failed; never raw internals |
| `processed_at` | datetime, nullable | when processing last completed |
| `embedding_status` | string, default `none` | `none` \| `pending` \| `ready` \| `deferred` \| `failed` — honest vector state (Phase 8 lifecycle) |
| `created_at` / `updated_at` | datetime | |

Memory types (controlled, seven): `experience`, `fact`, `thought`,
`event`, `idea`, `note`, `conversation`.

**Invariants.** `original_content` is never replaced by a summary or
any generated text. Edits create versions. AI enrichment (title,
summary, type, confidence, `remembered_at`) updates in place WITHOUT a
version — it is understanding, recomputable by design; version history
records the user's own meaningful changes (plus state updates applied
by the decision engine, each carrying a `change_reason`). `confidence`
is the AI's certainty about its understanding — a signal for decision
gates, never displayed as a number in the UI.

### memory_versions

Append-only history. `v1` ("created") is written when the memory is
created. A meaningful edit — a change to `original_content`, `title`,
or `summary` — appends the next version ("edited") capturing the NEW
state; earlier versions are never rewritten. Metadata changes
(`memory_type`, `importance`, `remembered_at`, `status`) update in
place without a version. `version_number` is unique per memory
(composite unique index). Versions live and die with their memory.

### entities

| Column | Type | Notes |
|---|---|---|
| `id` | string | |
| `user_id` | string | FK → users, cascade |
| `type` | string | `person` \| `place` \| `organization` \| `project` \| `topic` \| `object` |
| `name` | string | as given |
| `canonical_name` | string | normalized: trimmed, whitespace-collapsed, lowercased |
| `description` | string, nullable | |
| `created_at` / `updated_at` | datetime | |

Uniqueness: `(user_id, type, canonical_name)` — an exact canonical
match is **reused**, never duplicated. Ambiguous matches (same name,
different type) are separate entities and are **never silently
merged**. Intelligent resolution arrives later, as validated AI
proposals the user can review.

### memory_entities

Explicit join: `memory_id` + `entity_id` (composite primary key — one
link per pair; re-linking updates it), plus `role` (`participant`,
`subject`, `location`, `topic`, `mentioned`, `object`) and nullable
`confidence`. Both sides cascade on delete.

### relations

The graph foundation. Polymorphic endpoints by design:

| Column | Notes |
|---|---|
| `source_type` / `target_type` | `memory` \| `entity` |
| `source_id` / `target_id` | no foreign keys — polymorphic |
| `relation_type` | `related_to`, `involves`, `about`, `mentions`, `follows`, `caused_by`, `contradicts`, `replaces`, `participates_in` |
| `confidence` | nullable |
| `status` | `active` \| `archived` |
| `user_id` | every relation belongs to its creator |

Because endpoints carry no foreign keys, existence and ownership of
BOTH endpoints are verified in the application layer before any write
(`createRelation`), and no relation ever bridges two users. Graph
traversal is out of scope for Phase 2.

### sources

Provenance. `source_type` (`user_input` | `file` | `image` | `voice` |
`url` | `conversation`), `raw_content` (verbatim capture),
`reference_id` (what the source produced — the memory id for
user_input), `metadata` (JSON). Since Phase 9 the shape is fully
active: rich input writes `file`/`image`/`voice`/`url` sources with an
extraction state (`extraction_status`: pending | processing | ready |
partial | failed — deliberately separate from any memory lifecycle
status), a stable human-safe `extraction_error`, an opaque
`storage_key` for the preserved original, and a `dedup_key` for
idempotent ingestion. `memory_sources` (many-to-many) links memories
to sources: one memory may carry several sources (a screenshot + the
user's caption), and a source may back more than one memory. See
`docs/ingestion-system.md` for the pipeline behind them.

### memory_analyses (Phase 3)

One row per processing attempt — the intelligence layer's provenance
and debug surface:

| Column | Notes |
|---|---|
| `memory_id` | FK → memories, cascade |
| `user_id` | FK → users, cascade — provenance is user-scoped too |
| `attempt` | 1-based counter per memory |
| `status` | `succeeded` \| `failed` \| `rejected` (rejected = the proposal failed schema validation) |
| `decision` | `create` \| `update` \| `merge` \| `link` \| `conflict` \| `ignore` |
| `provider` | provider id (`zai`, `fixture`, …) |
| `analysis_json` | the VALIDATED analysis proposal |
| `comparison_json` | the VALIDATED comparison proposal |
| `decision_json` | the decision, its gates/corroboration trace, and the applied changes |
| `error_reason` | stable, human-safe failure reason |

Raw model output is deliberately NOT stored — only validated proposals
survive, so every record is explainable and re-derivable. Attempts are
append-only; nothing mutates a previous record. This is advanced,
internal information: it is not exposed in the user UI.

## 4. Ownership rules (Rule 1, binding)

1. Every service function takes an explicit `userId` and scopes every
   query by it. There is no code path that reads or writes a memory,
   entity, relation, source, or version without one.
2. Cross-user reads return **404 not_found**, never 403 — one user's
   ids are not another user's information. Existence itself is private.
3. Relations verify ownership of both endpoints before creation. A
   relation that would bridge users is rejected before it exists.
4. Authorization happens in the application service — before data is
   returned, never after.

## 5. Versioning rules (Rule 3)

- v1 at creation; append on every meaningful textual edit.
- Never overwrite or delete individual versions.
- The current `memories` row is the current state; versions are the
  states that came before. A memory's full past is retrievable via
  `GET /api/memories/:id/versions` and on the detail page.

## 6. Deletion rules (Rule 6)

Deleting a memory (a real decision, confirmed in the UI) atomically
removes:

- the memory row itself,
- its version history,
- its memory↔entity links,
- every relation touching it (either direction),
- its provenance sources — with the Phase 9 sharing rule: a source
  another existing memory still references (via `memory_sources`, or a
  legacy `reference_id` pointing at a live memory) survives untouched;
  sources referenced only by the deleted memory are removed, and the
  preserved originals + thumbnails behind them are deleted from the
  storage seam afterwards. No orphans, no lost files of surviving
  sources.

Entities are **not** deleted — they are reusable and may be linked
from surviving memories. Archiving (`status: archived`) is the soft
path when retention matters. No orphan references remain; nothing
unrelated is destroyed.

## 7. API surface

| Method & path | Purpose |
|---|---|
| `POST /api/memories` | Create (the front door; provisions identity on first keep; schedules real processing) |
| `GET /api/memories` | List (`q`, `status`, `memory_type`, `page`, `pageSize`) |
| `GET /api/memories/:id` | Read one (includes processing state) |
| `PATCH /api/memories/:id` | Edit (meaningful edits version) |
| `DELETE /api/memories/:id` | Delete (graph-safe, atomic) |
| `POST /api/memories/:id/process` | Retry/finish processing (Phase 3; 409 when already running) |
| `GET /api/memories/:id/versions` | Version history, oldest first |
| `POST /api/ingest` | Rich ingestion (Phase 9): multipart — image, audio, file, url, or unified text; rate limited |
| `GET /api/sources/:id/file` | Stream a preserved original or thumbnail (authenticated, ownership-checked, `no-store`) |
| `POST /api/sources/:id/retry` | Idempotent re-extraction (Phase 9; `process` rate-limit rule) |
| `GET /api/entities/:id` | Read one entity |
| `GET /api/entities/:id/memories` | Memories linked to the entity |
| `GET /api/entities/:id/relations` | Relations around the entity, labels resolved |

All responses use the `ApiResult` envelope: `{ ok: true, data }` or
`{ ok: false, error: { code, message } }`. Error codes: `unauthorized`
(401), `validation_failed` (400), `forbidden` (403), `not_found`
(404), `conflict` (409), `internal_error` (500). Database errors never
reach the client.

Request validation is Zod, at the service boundary:
`original_content` ≤ 10,000 chars and required (preserved verbatim —
not trimmed), title ≤ 200, summary ≤ 2,000, enums restricted to the
controlled vocabularies, ids length-checked. Unknown fields are
stripped. Client input is never trusted.

## 8. Identity and ownership today (honest smallness)

Kept is a personal, single-tenant product. Phase 2 needs real
ownership enforcement without shipping a login product. The mechanism:

- An anonymous **HMAC-signed identity cookie** (`kept_uid`) identifies
  the browser. It cannot be forged into another user's id.
- It is provisioned on the first keep (`POST /api/memories`) — a
  personal archive begins when something is kept — and every service
  call is scoped by the resolved user id.
- Real authentication (passkey, password, OAuth) will replace only the
  issuer/verifier in `src/lib/identity.ts`; every service already
  takes an explicit `userId`, so nothing else changes.

This is provisioning, not authentication, and it is documented as
such on purpose.

## 9. Database today, PostgreSQL tomorrow

**Current provider: SQLite** — the runtime this environment provides
(PostgreSQL is not available here). Phase 2 was built so the switch is
a migration, not a redesign:

- All tables/columns are mapped to snake_case names matching this
  document exactly (`memories`, `memory_versions`, `entities`,
  `memory_entities`, `relations`, `sources`; `user_id`,
  `original_content`, …). PostgreSQL will match the documented model
  1:1.
- No SQLite-specific behavior exists in domain or application code.
  Enum-like fields are strings validated app-side; on PostgreSQL they
  can graduate to native enums with no logic changes.
- `sources.metadata` is a JSON string today because Prisma does not
  support the `Json` type on SQLite; the repository (de)serializes it,
  and it maps to `Json` on PostgreSQL.
- To switch: change `provider` in `prisma/schema.prisma`, point
  `DATABASE_URL` at PostgreSQL, run `prisma migrate dev` to generate
  the migration history, and verify with the test suite
  (`bun run test`). Polymorphic relations and JSON columns work as
  documented — no second database, no graph database, no vector store
  is introduced by Phase 2. Vector search (pgvector) belongs to the
  semantic phase, on PostgreSQL, per the long-term architecture.

## 10. Current limitations (explicit)

- Entity linking is deterministic + AI-assisted, bounded by the
  analysis prompt's quality — the resolver never claims a match the
  evidence cannot support, which means some true matches stay unlinked
  (recorded as ambiguity instead).
- Retrieval for processing is keyword-based (`contains`) plus recency;
  it cannot find paraphrases that share no keywords. Corroboration
  keywords come from title + excerpt, so overlap can only be
  UNDER-estimated — which errs toward CREATE over UPDATE/MERGE, the
  safe direction.
- Processing runs in-process (Next.js `after()`), single-server. The
  atomic claim guard (`processing_status`) plus an in-process lock
  prevent double runs; a crashed run leaves `processing` behind only
  if the process dies mid-flight — the retry endpoint still recovers
  it, and a fresh deployment clears transient locks.
- Search remains ordinary database `contains` (case-insensitive for
  ASCII on SQLite; PostgreSQL will upgrade this transparently).
- Identity is anonymous-per-browser (signed cookie), not authenticated.

## 11. Intentionally deferred to Phase 4 and beyond

The Query Planner, the Retrieval Engine for user queries, semantic
search over embeddings, conversational Ask, memory chat, graph
traversal, reranking, timeline generation, reflection queries, and
answer verification. Phase 3's retrieval exists ONLY to feed
processing, is keyword-based, and is bounded. The embedding seam
(`lib/ai`) is ready but honestly deferred (see §13).

## 12. Phase 3 — the Memory Intelligence pipeline

The pipeline lives in `src/modules/intelligence` and runs whenever a
memory is saved (via Next.js `after()`) or retried
(`POST /api/memories/:id/process`):

```
USER INPUT (already saved — the memory exists before any AI runs)
  → gather bounded context        application/retrieval.ts
  → analyzeMemory (gateway)       → raw JSON → zod (domain/ai-schemas.ts)
  → entity candidate pool         deterministic, name-based, bounded
  → compareMemories (gateway)     → raw JSON → zod → filtered to shown ids
  → corroboration                 deterministic signals (shared entities,
                                  keyword overlap) — no AI involved
  → decision engine               domain/decision-engine.ts (pure rules)
  → entity resolution             domain/entity-resolution.ts
  → applyDecision                 ONLY through memory/entity public APIs
  → provenance                    memory_analyses (validated data only)
  → embedding attempt             honest deferral in this environment
  → processing_status = ready | failed
```

**Safety properties (all tested in `tests/memory-intelligence.test.ts`):**

1. The raw memory is saved FIRST; any failure leaves it saved with
   `processing_status = failed` and a human-safe reason.
2. The AI never writes. Every write goes through the memory/entity
   public APIs, which enforce ownership themselves.
3. The model can only reference ids that were in its context;
   fabricated references are discarded before any decision.
4. Invalid model output (unparseable or schema-violating) is rejected
   with NO partial writes and recorded as a `rejected` attempt.
5. Retries are idempotent: no duplicate memories, versions, relations,
   or entity links.
6. Cross-user isolation: retrieval, entity pools, and corroboration
   are all user-scoped; one user's processing can never touch
   another's graph.

### 12.1 Decision engine

The AI proposes evidence (matches, updates, conflicts, merge
candidates, entity matches, new relations) with confidence numbers.
It NEVER decides. The engine applies deterministic, ordered rules:

| Action | Fires when | Effect |
|---|---|---|
| IGNORE | the analysis marks `insufficient_content` AND there are no entities/facts/thoughts | nothing changes; raw input is always preserved |
| CONFLICT | a conflict proposal ≥ 0.75 AND corroborated | target gets a new version (old state preserved), incoming superseded, `replaces` + `contradicts` relations |
| UPDATE | an update proposal ≥ 0.75 AND corroborated | target gets a new version, incoming superseded, `replaces` relation |
| MERGE | a merge proposal ≥ 0.85 AND strongly corroborated | soft merge: incoming superseded (never deleted), linked back to the survivor, entities unioned |
| LINK | matches ≥ 0.70 | relations between distinct memories (`follows` / `related_to`), bounded 3/run |
| CREATE | default | enrichment + entity links only |

"Corroborated" means a shared entity OR keyword overlap above the
documented floor — AI confidence alone never rewrites an existing
memory. MERGE is deliberately the hardest gate: **false merges are
more harmful than duplicate memories.**

Thresholds live in `src/config/intelligence.ts`, each with its
rationale written next to it.

### 12.2 Entity resolution (deterministic-first)

1. **exact** canonical match → reuse (deterministic, no AI needed)
2. **normalized** deep match (diacritics, Arabic letter forms, case,
   punctuation) unique → reuse
3. **alias** — conservative Arabic→Latin transliteration
   (vowel-insensitive: أحمد ↔ Ahmed) unique → reuse ONLY when the
   proposer's confidence ≥ 0.65
4. **ambiguous** — multiple plausible candidates, or a lone partial
   match → link NOTHING, create NOTHING, record the ambiguity (both
   candidate ids) in the analysis record for later clarification
5. **none** → create a new entity (cheap, reversible)

The invariant: a wrong link is worse than a missing link, and a silent
merge is the worst outcome of all. "Ahmed — school" and
"Ahmed — university" stay separate; a bare "Ahmed" against both stays
unresolved and recorded.

### 12.3 Enrichment guard rules

AI enrichment of the INCOMING memory respects what the user already
chose:

- **title**: replaces only a derived (mechanical) or absent title —
  a title the user picked is recognizable because it differs from
  what `deriveTitle` would produce.
- **summary**: fills only when the user has not written one.
- **type**: upgrades only away from the neutral default `note`.
- **remembered_at**: fills only when absent AND the model's time
  confidence ≥ 0.8 — "maybe 2024" (low confidence) stays uncertain.
- **confidence**: always recorded (it IS the understanding signal).

Enrichment never creates a version; it is recomputable. The original
content is unreachable through the enrichment path by construction.

### 12.4 Processing states

`memory.status` (lifecycle) and `memory.processing_status`
(intelligence) are independent axes:

```
status:             active | archived | superseded      (the user's call)
processing_status:  pending → processing → ready | failed   (the system's honesty)
```

A failed memory is still a saved memory: the detail page says
"Couldn't finish processing" and offers a retry. The list shows a
quiet "Processing" whisper while work is in flight, and nothing at
all when ready — ready is the quiet default.

### 12.5 Prompts as assets

Prompts live in `src/prompts/` as versioned modules
(`memory-analysis/v1.ts`, `memory-comparison/v1.ts`), reviewed like
code and immutable once shipped: changes create v2 so old memories
remain explainable by the prompt that understood them. The gateway is
the only code that constructs AI requests; prompts never instruct the
model to save, update, or delete anything.

## 13. Embeddings — the engine is real, the provider is absent (Phase 8)

Phase 3 deferred the whole seam; Phase 8 built it out for real while
keeping the one missing piece honest. The definitive document is
`docs/semantic-memory.md`; the summary:

- The **contract** is complete: `EmbeddingRequest` (canonical text,
  purpose, memoryId) and `EmbedResult` carrying model + version with
  every vector; providers declare `embeds: true` and the gateway's
  `embeddingCapability()` gate requires it.
- The **canonical representation** (v1, versioned) is deterministic:
  title, then summary (or the user's own words when none), then linked
  entity names — derived text, never written back into the memory.
- The **repository** is real: `SqliteEmbeddingRepository` stores
  little-endian Float32 vectors in `memory_embeddings` (same database,
  no second DB), scores with true cosine, joins ownership through
  `memories.user_id`, and never compares across (model, version).
- The **pipeline** attempts an embedding after processing; every
  outcome is honest and non-blocking: `ready` when stored,
  `deferred` when the provider cannot embed (this environment),
  `failed` when a real attempt errored (retryable).
- **Edits invalidate**: a text change marks rows `pending` and moves
  the memory's status to `pending` — the old vector can never
  represent the new content. **Deletion removes** vectors via FK
  cascade plus an explicit repository delete.
- The **reprocessing service** (`modules/intelligence`) regenerates
  one, stale/failed, or all embeddings — bounded, idempotent, honest
  when no provider exists.
- What remains deferred is the PROVIDER: the z.ai SDK here has no
  embedding API. Production never stores or searches a vector today;
  the planner never schedules the semantic step; tests exercise the
  engine with deterministic fixture vectors only.

No code may bypass this seam to fake persistence. The architecture
remains ready; nothing is pretended.

## 14. Retrieval — where Phase 4 plugs in

Everything in this document concerns what a memory IS and how it is
kept. How a memory is FOUND again — query understanding, the Query
Planner, the retrievers (structured, keyword, entity, temporal, graph;
semantic honestly deferred), merging, ranking, context building, the
Search and Ask APIs — is the query module's territory and is specified
in **`docs/query-system.md`**.

Two touches on this document's territory:

1. **Retrieval is read-only and status-filtered.** Search and Ask
   surface `active` memories by default; a bounded re-plan may widen
   to `archived`. `superseded` states stay out of results — their
   content lives on in the replacing memory and its version history.
2. **Retrieval consumes additive read helpers** this module exposes
   since Phase 4 (`getMemoriesByIds`, `listMemoriesInWindow`, summary
   -inclusive search, batched graph adjacency in the entity module).
   The query module still never touches Prisma directly; ownership
   stays structural on every retrieval path.

### 15. Chat as a memory surface (Phase 5)

The conversation can now touch memory — but only through the same
doors as everywhere else. When the user explicitly says so
("افتكر إني…", "remember that…", detected deterministically from the
user's words — never by a model's decision), the ask pipeline creates
the memory **through this module's public API** (`createMemory`,
verbatim content, v1 version, user-input source) and the API route
schedules the Memory Orchestrator exactly like `POST /api/memories`:
save-first, normal validation, processing states, retry. The chat
layer never writes the database directly.

Explicit deletion requests ("احذف…") run the **existing deletion
flow** (`deleteMemory` — ownership verified, graph-safe cleanup,
entities survive) — but only when the target is unambiguous: the
focused memory of a memory-scoped conversation, or exactly one
strongly-relevant candidate. Anything else gets a concise
clarification, never a guess. Conversational corrections do not
silently rewrite history; a correction that represents a real memory
change is captured explicitly (see `docs/reasoning-system.md` §7).

## 16. Exploration — where Phase 6 plugs in

How memories are WANDERED — the People and Topics indexes, entity
pages, the timeline, "more like this", and the discovery strip — is
the exploration module's territory and is specified in
**`docs/exploration-system.md`**. Three touches on this document's
territory:

1. **Exploration surfaces ACTIVE memories only** (counts, lists,
   timeline) — the same default visibility retrieval established.
   Archived/superseded memories stay reachable through their own
   pages; they stop populating the wandering surfaces.
2. **The timeline shows only KNOWN event dates** (`rememberedAt`).
   Memories without one are counted honestly ("N memories have no
   known date") and never placed with the kept-date proxy — the
   timeline is stricter than retrieval, which may use the proxy to
   answer "what happened last month".
3. **Entity pages read through additive read-only helpers** this
   module and the entity module expose (paged link queries, count
   aggregates, dated-memory reads). No exploration code writes here,
   and deleting a memory disappears from every surface automatically
   through the existing cascade.

## 17. Accounts and ownership — where Phase 7 plugs in

Every row this document describes belongs to a user id, and since
Phase 7 that id comes from a REAL authenticated session — never from a
signed anonymous cookie, a request body, or a query string. What
changed, and what did not:

1. **What changed: identity resolution only.** The seam Phases 2–6
   left open (`src/lib/identity.ts` + the provisioning path) is now
   session-based: `requireCurrentUserId()` resolves the HttpOnly
   session cookie, looks up the hashed token in `sessions`, and 401s
   anonymous callers. `POST /api/memories` no longer provisions an
   owner on first write — an archive begins with an account.
2. **What did not change: scoping.** Every service still takes an
   explicit `userId` and scopes every query by it. Ownership checks,
   cross-user 404s, and cascade deletions behave exactly as before —
   the 180 prior tests pass untouched.
3. **Legacy data policy.** Anonymous rows created before accounts are
   development data. They are never silently attached to an account:
   the only door is the explicit claim (`Settings → Data`), which is
   transactional, merges colliding entities rather than duplicating
   them, deletes the legacy row, and spends the claim cookie in one
   shot (see `docs/security.md` §7).
4. **The intelligence pipeline is unaffected.** Processing, entity
   resolution, and the decision engine operate exactly as before —
   they already received explicit owner ids. Rate limits now bound how
   often a user may trigger processing (20/5min per user).
