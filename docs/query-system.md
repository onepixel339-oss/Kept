# Kept — The Query & Retrieval System (Phase 4)

This document is the source of truth for how a question becomes a
retrieval. When code and this document disagree, one of them is wrong —
fix it immediately.

**Phase boundary, stated plainly: Phase 4 implements retrieval and
query planning. Final reasoning/answer verification belongs to
Phase 5.** The pipeline stops at the ContextPack; nothing in this
phase generates an answer, and the UI says so.

## 1. The lifecycle

```
USER QUESTION
    ↓
QUERY UNDERSTANDING        ask-service (AI proposal, zod-validated;
    ↓                       deterministic fallback — never a blocker)
QUERY PLANNER              planQuery (deterministic, inspectable)
    ↓
SEARCH PLAN                intent · scope · retrievalSteps · filters · budgets
    ↓
RETRIEVAL                  orchestrator runs the plan's steps in order,
    ↓                       failures contained, seeds shared
MERGE                      one candidate per memory, full provenance
    ↓
RANK                       deterministic, intent-weighted
    ↓
(re-plan at most once when nothing useful came back — bounded)
    ↓
CONTEXT BUILDER            ContextPack — the Phase 5 boundary
```

The planner is **never bypassed**: there is no code path from a raw
question straight to the database. `GET /api/search` runs the same
pipeline with the deterministic understanding (no AI call at all);
`POST /api/chat` runs it with AI understanding and a deterministic
fallback.

## 2. Query understanding

`understandQuery()` is an AI Gateway operation (`lib/ai`): the query
module sends the question, current date/timezone, the active scope, a
bounded recent conversation slice, and the user's **known entities**
(bounded id/type/name list), and receives a raw JSON proposal it
validates against `queryUnderstandingProposalSchema`
(`modules/query/domain/understanding.ts`).

The validated shape:

```ts
{
  intent: "recall" | "find" | "summary" | "timeline" | "comparison" | "explore" | "reflect",
  mentions: [{ mention, type | null, qualifier | null, entityId? | null }],
  topics: string[],
  time: { kind, from, to, expression, uncertain },
  scope: "global" | "memory" | "entity" | "topic",
  depth: "narrow" | "medium" | "broad",
  needsReasoning: boolean
}
```

Rules the validator enforces (not the prompt — the code):

1. **Closed vocabularies.** Unknown intent/type/scope/depth → the
   proposal is rejected and the fallback takes over.
2. **Mentions are evidence, not entities.** A mention is text the user
   wrote. Resolution happens later, deterministically, against the
   user's actual entities.
3. **AI-proposed entity ids are hints.** A mention may carry
   `entity_id` (the model suggesting which saved entity a
   cross-language reference points at — "المشروع" → "website
   project"). The ask service strips any id not in the user's known
   list; the entity retriever re-verifies ownership independently;
   and a proposal is used ONLY when deterministic matching found
   nothing — it never overrides deterministic evidence and never
   resolves an ambiguity (basis "ai", score 0.8).
4. **Time is normalized by the system's own clock.** Relative
   expressions proposed by the model are re-resolved through
   `resolveTimeExpression` (see §7). Unparseable dates degrade to
   `uncertain: true` with the user's words preserved — never
   fabricated precision. `from > to` is swapped.
5. **Unknown fields are stripped; fences and prose are tolerated**
   (same parse discipline as the intelligence module).

**The deterministic fallback.** When the gateway is unavailable,
throws, or returns garbage, `buildFallbackUnderstanding` builds a
conservative understanding from deterministic evidence only: intent
from question-word patterns (Arabic + English), mentions matched
against the user's own entity names (direct match first, then the
same cross-script transliteration alias the entity module uses),
topics from the user's topic entities, time from
`resolveTimeExpression`. The run records `understandingSource:
"fallback"` and the UI says "Kept read this question with its own
words, not its understanding model."

## 3. The Query Planner

`planQuery` (`modules/query/domain/planner.ts`) is pure and
deterministic: understanding in, `SearchPlan` out. It decides WHICH
mechanisms run — never how. The general rules (spec §2's examples,
generalized):

| Question shape | Plan |
|---|---|
| entity mention / recall ("فاكر أحمد؟") | entity + keyword (no graph for narrow recall) |
| month/year window ("ذكرياتي في أغسطس") | temporal + keyword |
| entity + topic | entity + keyword + graph |
| summary / timeline / reflect / comparison | entity/topic + graph (+ temporal when a window resolved) |
| scope = memory | structured (that exact memory) |
| embeddings available | + semantic (never scheduled when deferred) |

Graph depth follows question breadth, hard-capped: narrow → 1,
medium → 2, broad → 3 (`maxGraphDepth`). The final-memory budget
follows depth: 8 / 15 / 25. Every value lives in
`src/config/query.ts` with its rationale.

`reasoningMode` is derived from `needsReasoning` ("light" for
summaries/comparisons/reflections) — it is recorded for Phase 5 and
executed by no one in Phase 4.

### Re-planning (bounded)

When a run produces nothing (no results at all, or nothing at or above
`minUsefulScore`), the orchestrator widens the plan ONCE
(`widenPlan`): archived memories join the filter, a starving temporal
window is dropped, keyword terms expand, and the graph deepens within
the cap. `maxPlanningIterations: 2` bounds the loop; widening is
monotonic, so a plan can never oscillate or repeat itself. The UI
reports "searched again, wider (attempt 2)" when it happened.

## 4. The Retriever interface

```ts
interface Retriever {
  readonly id: RetrieverId; // structured | keyword | entity | temporal | graph | semantic
  retrieve(input: RetrievalInput): Promise<RetrievalOutput>;
}
```

The planner never knows implementations; the orchestrator knows no
retriever internals. Every retriever's input carries the userId and
the plan's filters (`statuses` binds ALL retrievers — a superseded
memory stays out unless a widened plan included it). Failures are
contained: one retriever throwing is recorded in
`run.failures` and the rest still run.

### 4.1 StructuredRetriever
Exact filtering only: a scope-focused memory id, memory-type
restrictions. Direct reads, score 1.0, no scoring subtleties.

### 4.2 KeywordRetriever
Probes each term through the memory module's own search (title +
summary + original content — summary search is Phase 4-additive),
then scores full rows once (batched): matched distinct terms / total
terms, +0.15 title bonus. **Honest SQLite limitation, documented and
claimed nowhere else:** `LIKE` is case-insensitive for ASCII only,
with no stemming — Arabic matches on exact substrings, and "running"
will not match "ran". No linguistic behavior is faked.

### 4.3 EntityRetriever
Resolves every mention through the entity module's deterministic
ladder (exact → normalized → alias/transliteration → partial), then
retrieves the memories linked to each resolved entity (direct links +
memory↔entity relations). Scores by basis: exact 1.0, normalized
0.95, alias 0.75, partial 0.5, AI-proposed 0.8.

**Ambiguity rule (binding):** one mention matching several equally
strong entities (two "Ahmed"s) is NEVER silently combined. Each
candidate's memories are retrieved separately — a memory is tied to
exactly one candidate — and the ambiguity is recorded for the planner
and UI ("tell me which Ahmed"). Deterministic evidence outranks the
AI's proposal; the proposal never resolves an ambiguity.

### 4.4 TemporalRetriever
Reads the plan's resolved windows through the memory module's windowed
query: `rememberedAt` when known, the kept-date as an honest proxy
when not (a memory without an event date can still belong to a month).
Score 1.0 in-window; uncertain windows say "approximate" in the
reason.

### 4.5 GraphRetriever
Bounded BFS from the seeds earlier steps produced (resolved entity
ids, found memory ids), across both edge families: memory↔entity
links and the polymorphic relations. Safety rails, all structural:

- depth from the plan (planner-capped at 3), node cap (24),
- a visited set — cycles terminate, always,
- ownership by construction: every adjacency read is user-scoped, so
  a cross-user edge is unrepresentable, not merely forbidden.

Score = 1/distance (direct connection 1.0, two steps 0.5 …). Seeds
themselves are never emitted — the graph's job is what they CONNECT
to. Adjacency is read in batched frontier queries (no per-node N+1).

### 4.6 SemanticRetriever — real code, honestly gated (Phase 8)
The retriever is fully implemented (spec §8): embed the question once
(transient, never persisted), cosine-search the user's own stored
vectors, re-read every candidate through the owned path, and emit
results with `source: "semantic"`, the normalized cosine score, and
provenance. What keeps it honest is the GATE, not a stub: it runs only
when the provider genuinely embeds AND the repository is available —
and in this environment the z.ai SDK has **no embedding API**, so the
gate is closed, the planner never schedules the step, and the run
report says `semantic: "deferred"`. **No fake embeddings, no random
vectors, no keyword search pretending to be semantic, no mock
scores.** The full contract, the real SQLite vector repository, the
lifecycle, and the activation path are documented in
`docs/semantic-memory.md`.

## 5. Merging and ranking

**Merge** (`domain/merge.ts`): one candidate per memory, sources
unioned, best score per source kept, matched entities/terms unioned,
minimum graph distance kept. Duplicates never reach ranking or the
context.

**Rank** (`domain/ranking.ts`): deterministic arithmetic over
provenance — no AI call. Signals (0..1): entity match, keyword match,
semantic cosine (Phase 8 — 0 when absent, never faked), temporal fit,
graph proximity (`1/(1+distance)`), stored importance, gentle recency
(half-life ≈ 1 year), source-count corroboration. Weights per intent
live in `config/query.ts` with their rationale (recall leans entity;
timeline leans temporal; summary leans corroboration; semantic is
weighted so an exact match always outranks a merely-similar memory).
Tie-breakers make the order total and stable: relevance → source
count → importance → recency → id. **The score means "relevance to
this query" — never "importance in the user's life."**

## 6. Budgets

`src/config/query.ts` — configuration, not laws; each carries its
rationale: max results per retriever (12), merged candidates (40),
graph depth (3) / nodes (24), keyword terms (6), final memories by
depth (8/15/25), planning iterations (2), AI calls per ask (1 in
Phase 4 — understanding only), conversation window (8 messages),
context caps (30 memories / 20 relations); Phase 8 semantic budgets:
one query embedding per question, max semantic results (10), minimum
semantic cosine floor (0.2).

## 7. Temporal resolution (deterministic)

`domain/time-resolution.ts` is the authority on dates. Supported:
relative rolling windows ("last 3 months", "آخر شهر"), calendar
months (English + Egyptian Arabic, most recent past occurrence,
uncertain when the year was assumed), seasons ("الصيف اللي فات",
winter's wrap-around included), explicit years (Arabic-Indic digits
included), ISO dates, today/yesterday. "الشهر اللي فات" is resolved
as a rolling window and flagged uncertain (an interpretation choice,
stated). Anything unresolvable returns null — the caller preserves
the raw words as an uncertainty instead of guessing.

## 8. Context building (the retrieval/reasoning boundary)

`buildContext` produces the `ContextPack`: the question, the
validated understanding, bounded memories each carrying WHY (sources,
scores, matched evidence, relevance, a one-line reason), resolved
entities with their basis, bounded relations touching the context's
nodes, a timeline for timeline/summary/reflect intents (kept-date
proxies flagged), uncertainties, ambiguity, and the run's honest
telemetry (`understandingSource`, `planIterations`, `failures`,
`semantic`).

Memory ordering is intent-aware: timeline → chronological (event
date, proxies flagged); summary/comparison → relevance with a
chronological tie-break; explore/reflect → coverage-first (each new
memory should add entities the pack has not seen); recall/find →
relevance. **Never the whole database — only what the planner found
and the ranker kept.**

Phase 5 consumes this pack: the ask pipeline projects it (bounded,
plain data, ids identical to the pack the UI displays) into the
reasoning step — see `docs/reasoning-system.md`. The pack remains the
boundary: reasoning never retrieves around it.

## 9. Ownership

Non-negotiable and structural: authentication happens before
retrieval (`requireCurrentUserId` — 401, never guessing); every
retriever's reads are user-scoped by construction; graph traversal
cannot cross users because adjacency queries are scoped; an unknown
or foreign conversationId yields an empty window, not another user's
words. No frontend-provided user id is trusted anywhere.

## 10. APIs

**`GET /api/search?q=...`** — deterministic grouped search (no AI
call). Returns `{ memories, entities, topics, time, semantic,
planIterations, failures }`, sized small (`search.max*` = 10/8/6).
Response memories carry relevance, sources, and a reason. No
identity → 401.

**`POST /api/chat`** — the Ask pipeline's front door, completed in
Phase 5: authenticate → save the user message (verbatim) →
understand → plan → retrieve → build context → **route on the user's
explicit chat intent** (deterministic detection: capture → the memory
module + the orchestrator scheduled by the route; unambiguous deletion
→ the existing deletion flow; count → database count; empty pack →
honest no-evidence line; plain find → deterministic listing;
otherwise → grounded reasoning with the bounded verification loop) →
persist the assistant record (final answer + provenance — never
hidden reasoning) → return the structured result
(`{ conversationId, understanding, context, answer, action? }`). The
`answer` payload carries the prose, the grounded claims with their
memory ids, `supportingMemoryCount` ("Based on N memories"),
uncertainties, style, and a verification status. Chat scopes
(`global | memory | entity | topic`) reuse the same planner and
retrievers — scope is an input (a seed id), not a separate engine.
See `docs/reasoning-system.md` for the reasoning half.

## 11. Surfaces

- **/search** — editorial search page (server component): grouped
  results (memories with provenance whispers, "people & things in
  play" chips → `/search?entity=<id>` scoped views, topics), honest
  empty states, the time window searched when one resolved — and,
  on a scoped view, "Chat about <entity>" (entity-scoped conversation,
  spec §11).
- **/ask** — the question box and its grounded answer: what was
  understood (intent, time, re-plans), the answer as calm prose,
  "Based on N memories" with a "View the memories behind this"
  disclosure linking the supporting memories, ambiguity surfaced with
  links, uncertainties whispered, honest no-evidence behavior, a
  subtle loading state, and a retry affordance on failure. In-chat
  capture and deletion acknowledge honestly what happened. Follow-ups
  keep the conversation id; nothing is a chat bubble.
- **/memories/[id]** — each memory's page carries "Ask about this
  memory" (memory-scoped conversation, spec §10): the conversation
  starts at the focused memory and may reach the memories around it.

## 12. Current limitations (documented, not hidden)

1. **Semantic retrieval is deferred in production.** The full engine
   (contract, SQLite vector repository, retriever, ranking signal,
   lifecycle, reprocessing) is real and fixture-tested — but no
   installed provider can embed, so the planner never schedules the
   step and the deferral is reported honestly. See
   `docs/semantic-memory.md` §1 and §13.
2. **SQLite keyword search is substring-based** (ASCII case-folding,
   no stemming). Cross-script term matching in questions goes through
   the deterministic transliteration ladder only (أحمد ↔ Ahmed).
3. **Cross-language entity references** ("المشروع" → "website
   project") depend on the understanding model's entity_id proposal —
   deterministic-only searches will miss them; the fallback path
   documents this by falling back to keyword probes.
4. **Keyword probing does one bounded read per term** (≤ 6-10 reads
   per run on an indexed, local SQLite database — deliberate, simple;
   batch only when evidence demands it).
5. **Ranking weights are judgment calls** — documented, configurable,
   expected to be tuned as real usage accumulates.
6. **The conversation window is bounded, not summarized** — long
   conversations older than 8 messages are invisible to follow-up
   understanding (deliberate; bounded context, not a summary model).

## 13. What Phase 4 did NOT build (and Phase 5 did)

Phase 4 stopped at the ContextPack. Phase 5 built everything on the
other side of it — grounded answer generation, verification,
provenance, scoped chat, and in-chat memory mutation routing —
documented in `docs/reasoning-system.md`. Phase 6 added the
exploration surfaces (People / Topics / Timeline); Phase 7 added real
accounts and data rights. Phase 8 built the full semantic-memory
engine behind an honest gate — `docs/semantic-memory.md` — with the
activation blocker isolated to one fact: no installed provider offers
an embedding API. Still not built: pgvector or any second database;
fabricated vectors or semantic scores of any kind.
