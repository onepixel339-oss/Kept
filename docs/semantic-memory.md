# Semantic Memory & Hybrid Retrieval (Phase 8)

## 1. Position

Memories can be related by **meaning** even when they share no words.
"سافرنا إسكندرية وقعدنا على الكورنيش" and "فاكر اليوم اللي قضيناه على
البحر؟" are about the same day. Phase 8 adds semantic retrieval as one
more signal inside the existing hybrid engine — it does NOT replace
keyword, entity, structured, temporal, or graph retrieval, and it never
outranks an exact match.

**The honest headline of this environment:** the z.ai SDK installed
here exposes **no embedding API** (its full surface is chat/vision,
tts/asr, images, video, functions — verified against the installed
package), no alternative embedding provider is permitted by the
project's runtime policy (user-free, no client keys, no new paid
services), and no PostgreSQL/pgvector exists in this environment.
Therefore **production semantic retrieval is deferred — honestly**:
nothing is faked anywhere (no invented vectors, no keyword search
pretending to be semantic, no mock scores). What Phase 8 built for
real is everything AROUND that gap, so activation is a provider swap,
not surgery:

- the complete embedding contract (`EmbeddingRequest`, `EmbedResult`
  with model/version, provider capability flag),
- a REAL SQLite vector repository behind the seam (Float32 storage,
  true cosine search, structural ownership),
- the full embedding lifecycle wired into the memory pipeline, edits,
  and deletion,
- the SemanticRetriever as real, gated code,
- hybrid ranking with a semantic signal,
- the internal reprocessing service,
- and 26 fixture-driven tests covering the 20 behaviors the spec lists.

The spec's acceptance criteria allow exactly this state: *"real
semantic embeddings work OR their deferral is honestly preserved if
unavailable."* §25 says it plainly: when real embeddings are
unavailable, *verify the deferral path honestly and do not fake live
semantic behavior* — which is what live verification did.

## 2. The embedding contract (`lib/ai`)

```ts
interface EmbeddingRequest {
  text: string;                       // canonical representation (memory) or raw question (query)
  purpose: "memory" | "query";
  memoryId?: string;                  // provenance for memory embeddings; never for queries
}

type EmbedResult =
  | { available: true; vector: number[]; dimensions: number;
      model: string; version: string }  // model/version travel WITH the vector
  | { available: false; reason: string };
```

Providers declare `embeds: true` (a static, honest capability flag) AND
implement `embed()`. The gateway's `embeddingCapability()` gate reports
`{ provider, storage, ready }`; `ready` requires both. For the z.ai
provider both are false today, so nothing probes the network in vain.

Laws unchanged: the gateway is the only door to providers; providers
never see database rows; a query embedding is **transient by contract**
— nothing may persist it or store it as a memory.

## 3. The canonical representation (`modules/intelligence/domain/embedding-representation.ts`)

A memory is not embedded field-by-field. Representation **v1**
(`EMBEDDING_REPRESENTATION_VERSION = "v1"`) is deterministic:

```
line 1: title (when one exists)
line 2: summary — otherwise the user's original content
line 3: linked entity names, comma-joined
```

- The user's own words are used when no summary exists — meaning must
  come from somewhere real.
- `original_content` is **never modified**; the representation is
  derived text that is never written back into any memory field.
- Bounded at 2000 characters (embedding inputs have token limits);
  truncation prefers whole lines and is documented, not silent.
- The version constant is part of every embedding's stored identity:
  change the representation rule ⇒ bump the version ⇒ every existing
  vector becomes stale by construction — regenerable, never silently
  current.

## 4. Vector storage (`lib/ai/sqlite-embeddings.ts`)

The `EmbeddingRepository` seam (Phase 3) is now backed by a real
implementation:

| Aspect | Choice |
| --- | --- |
| Table | `memory_embeddings` (additive; same database — no second DB) |
| Identity | `(memory_id, model, version)` unique — retries upsert the same logical row (spec §6 idempotency) |
| Columns | `model`, `version`, `dimensions`, `status` (pending/ready/failed), `vector` (little-endian Float32 BLOB), timestamps |
| Encoding | Float32 little-endian via `DataView`; exact round-trip |
| Similarity | true cosine, computed in application code |
| Scale honesty | a personal archive is hundreds–low-thousands of vectors per user; a bounded scan of one user's own rows is milliseconds. No ANN index is pretended |
| Ownership | structural: every search joins through `memories.user_id`; no query can surface another user's vector |
| Compatibility | search and find filter on the exact `(model, version)` pair — vectors from different models are **never compared** (spec §4) |

Why implement SQLite storage at all when the provider is the missing
piece? Because the spec instructs exactly that ("implement the
provider/repository contract") and because it makes the whole semantic
path real and testable with deterministic fixture vectors — the
activation blocker is provably isolated to the provider layer.

`DeferredEmbeddingRepository` remains for environments that must
represent "no storage".

## 5. SemanticRetriever (`modules/query/application/retrievers/semantic.ts`)

Real code, honestly gated:

1. gate on `embeddingCapability().ready` — closed in production today,
   so the planner never schedules the step and the run reports
   `semantic: "deferred"`;
2. embed the question **once** (spec §13: one query embedding per
   query) — transient, never persisted;
3. cosine-search the user's own vectors, `(model, version)`-matched,
   `maxSemanticResults`-bounded, floored at `minSemanticScore` (0.2
   cosine — below that a hit is noise, not a candidate);
4. re-read every candidate through the memory module's owned path and
   apply the plan's status/type filters;
5. emit results with `source: "semantic"`, the normalized cosine as
   score, and provenance (`"similar in meaning to your question"`).

Failure at any point is contained: a provider failure returns an
honest `unavailable` reason, a thrown error is isolated by the
orchestrator — either way the other retrievers' results stand (§14).

## 6. Planner integration (spec §10)

Semantic is scheduled **only** when it can run AND meaning-level
similarity plausibly helps — never blindly:

| Question shape | Scheduled strategies |
| --- | --- |
| "ذكريات أغسطس" (resolved window, listing intent) | structured + temporal — **no semantic** |
| "فاكر اليوم اللي قضيناه على البحر؟" (meaning-led recall) | semantic (+ keyword) |
| "إيه اللي حصل بيني وبين أحمد في المشروع؟" | entity + graph + keyword + semantic |

Rule: semantic joins when no time window resolved, or the intent is
meaning-led (recall / explore / reflect / comparison).

## 7. Hybrid ranking (spec §11–12)

`ranking.ts` adds one signal — `semantic` (the cosine, 0 when absent)
— to the existing deterministic model. Weights per intent live in
`config/query.ts` with their rationale; they are tuned so a direct
entity/keyword match keeps beating a merely-similar memory (recall:
entity 0.35 vs semantic 0.20). While embeddings are deferred no
candidate carries a semantic score, so the signal contributes exactly
nothing — zero behavior change versus Phase 7 ranking except the
rebalanced weight tables. Ranking stays deterministic after retrieval:
same input, same order, tie-breakers intact. The score still means
"relevance to this query", never "importance in the user's life".

## 8. Lifecycle (spec §5, §21, §22, §16)

| Event | What happens | Memory remains |
| --- | --- | --- |
| **Created + processed** | pipeline builds the representation → gateway embed → repository stores under (model, version) → status `ready`; provider cannot embed → status `deferred` | fully usable in every state |
| **Text edited** | version appended (existing rule) AND embedding invalidated: rows → `pending`, memory status → `pending` — the old vector drops out of every search immediately | fully usable; reprocessing regenerates |
| **Deleted** | FK cascade removes the rows + explicit repository delete (defense-in-depth) — a deleted memory's embedding is unretrievable (tested) | — |
| **Model/version change** | old vectors read as stale by construction (identity mismatch); `regenerateAllEmbeddings` rebuilds progressively | fully usable throughout |

`embeddingStatus` vocabulary: `none | pending | ready | deferred |
failed` — each state honest, none blocking normal use.

## 9. Reprocessing (spec §15)

`modules/intelligence/application/embedding-reprocessing.ts` — a
simple internal application service, deliberately not an admin
dashboard, not a REST endpoint, not a job queue:

- `regenerateMemoryEmbedding(userId, memoryId)` — single repair,
- `regenerateStaleEmbeddings(userId)` — drains `pending`/`failed`
  (edits and provider errors) in bounded batches (200/run),
- `regenerateAllEmbeddings(userId)` — the model/version-change path.

Bounded, idempotent (identity upsert), progressive (§16: the rest of
the app never blocks), and honest: with no capable provider every
function returns a truthful report and touches nothing.

## 10. Fallback (spec §14)

Proven live and by construction: the semantic step failing — deferred,
provider error, or exception — never stops keyword / entity /
structured / temporal / graph. If ALL retrieval fails, the existing
honest empty behavior answers ("مش لاقي حاجة في ذكرياتك المحفوظة…"
after a bounded wider re-plan). No technical error is shown merely
because semantic was unavailable.

## 11. Privacy (spec §20) & observability (§27)

- Embeddings are derived from personal memories: private, user-owned
  data. The repository's ownership join makes cross-user search
  structurally impossible (tested at repository AND retriever level).
- No memory text is logged during embedding: logs carry duration,
  memory id, model, version, dimensions, and outcome only.
- Query embeddings are transient; nothing about a question is stored
  beyond the chat message the user already sees.
- All provider access stays server-side behind the gateway; no user
  API keys exist or are required (§19).

## 12. Migration path (spec §7, goal 10)

When PostgreSQL/pgvector becomes available:

1. switch the Prisma datasource to `postgresql` (the schema was
   written for this — snake_case, plain-string enums, mapped JSON);
2. alter `memory_embeddings.vector` from BLOB to pgvector `vector`
   (dimensions fixed by the provider's model);
3. replace `SqliteEmbeddingRepository` with
   `PgVectorEmbeddingRepository` behind the same interface — cosine
   (or the provider's documented metric) via pgvector operators;
4. index choice decided by ACTUAL dataset size and pgvector support at
   migration time (personal archives: a sequential scan over ≤10⁴
   rows is fine; HNSW/IVFFlat only when evidence demands it) — the
   spec forbids guessing index types;
5. re-embed everything via `regenerateAllEmbeddings` — model/version
   identity makes the run idempotent and resumable;
6. flip the new provider's `embeds` to `true`. Nothing above the seam
   changes: not the planner, not the retriever, not the ranker.

## 13. Limitations (documented, not hidden)

1. **No production embeddings in this environment** — the deferral is
   the headline of §1; every layer below the provider is real and
   tested with fixtures.
2. **Cosine is brute-force in SQLite** — correct and fast at personal
   scale; no ANN index is claimed.
3. **The semantic floor (0.2 cosine) and weights are judgment calls**
   — configuration with rationale, to be tuned against real provider
   behavior when one exists.
4. **Representation v1 is deliberately simple** (title/summary-or-
   content/entities); it will evolve with its version constant, and
   each bump regenerates everything honestly.
5. **Live semantic behavior was NOT demonstrated** — per spec §25 the
   deferral path was verified live instead; faking it live would be a
   violation, not a feature.
