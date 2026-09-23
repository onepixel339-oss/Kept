# Kept — The Exploration System (Phase 6)

This document is the source of truth for the exploration surfaces:
People, Topics, Timeline, and the quiet connections between memories.
When code and this document disagree, one of them is wrong — fix it
immediately. Future agents: read this file before touching
`modules/exploration` or the exploration routes.

## 1. Where exploration sits

Phases 1–5 built the engine: memory storage, intelligence, entities,
relations, versions, retrieval, grounded reasoning, scoped chat.
Phase 6 turns the resulting graph into **human-facing navigation** —
"the graph already exists; this phase exposes it through useful
surfaces." Exploration is the front of the house, not a new engine.

The flow, top to bottom:

```
People / Topics / Timeline / Memory Detail pages
        ↓
Exploration services (modules/exploration/application)
        ↓  composes PUBLIC APIs only
modules/entity (aggregates, adjacency)   modules/memory (dated rows, batches)
        ↓
Database — deterministic queries only. No AI anywhere.
```

What exploration is NOT:

- not a new retrieval engine (the Query Planner + Retrievers remain the
  only path from a question to memories);
- not a recommendation engine ("more like this" is shared-appearance
  derivation that names its reasons);
- not an analytics dashboard (counts are descriptive, never judgments);
- not a graph visualization (connections are prose, not nodes).

## 2. The module

`modules/exploration` owns the People and Topics indexes, the entity
detail data, the global timeline, similar memories, and the discovery
strip. It is an **application-only module** — no infrastructure layer,
because it performs no Prisma of its own. Everything is derived through
two modules' public APIs, extended additively for this phase:

- **entity module** (read-only aggregates): `listEntitiesByTypes` (paged),
  `countActiveMemoriesForEntities` (one grouped aggregate),
  `lastKeptForEntities`, `listRecentMemoryIdsForEntities` (bounded per
  entity), `listMemoryIdsForEntityPaged` (link-level pagination).
- **memory module** (read-only): `listDatedMemories` (paged, event dates
  only), `countUndatedMemories` (the honest note's number).

Boundary rules that hold here as everywhere:

- Ownership is structural — every call carries the userId; another
  user's entity throws `not_found`, exactly like a missing one.
- No cross-module Prisma: exploration composes public APIs only. (The
  one join-filter exception mirrors existing precedent: the memory
  repository may filter its own rows through the `memory_entities`
  join, just as the entity repository scopes links by `memory.userId`.)
- Everything is bounded: page sizes, per-entity probes, timeline caps.
  A person with 10,000 memories pages through them in chunks; nothing
  loads an unbounded set.

## 3. Surfaces

| Route | What it shows | Bounds |
|-------|---------------|--------|
| `/people` | Every person entity, alphabetical, with memory count, last-kept date, related topics | 24/page |
| `/people/[id]` | Name, topics, paginated memories, timeline, connections, scoped chat | 20 memories/page; timeline ≤ 60 dated |
| `/topics` | Topic + project entities, same quiet facts | 24/page |
| `/topics/[id]` | Name, people, paginated memories, timeline, connections, scoped chat | same as person |
| `/timeline` | Dated memories grouped year → month, optional `?entity=` filter, honest undated note, ask-about-period | 20 memories/page |
| `/memories/[id]` | Existing detail + clickable entities + "More like this" | ≤ 6 suggestions |
| `/memories` | Existing archive + discovery strip (people/topics mentioned) | ≤ 6 each |

### Entity → route mapping (`lib/entity-links.ts`)

One place decides where a saved thing opens:

- `person` → `/people/[id]`
- `topic`, `project` → `/topics/[id]`
- `place`, `organization`, `object` → `/search?entity=[id]` (the
  existing scoped view — a real destination, never a dead link)

No entity has two pages; entity pages correspond to actual entity
records; entity ownership is enforced by the underlying `getEntity`.

## 4. Counts, recency, and honest dates

- **Counts are database aggregates.** `countActiveMemoriesForEntities`
  runs one grouped query; the reasoning model is never asked to count.
- **Counts cover ACTIVE memories only.** Archived and superseded rows
  follow the visibility rules retrieval established in Phase 4
  (superseded excluded from default search). They remain reachable
  through their own pages — exploration simply stops surfacing them.
- **"Last kept" is a kept-date.** `lastKeptAt` is derived from
  `createdAt` — when something was kept is always true and never
  presented as when it happened.
- **The timeline only holds known event dates.** A memory enters the
  timeline only through its own `rememberedAt`. Memories without one
  are NOT placed with a fabricated or proxy date; they are counted and
  reported on the timeline page ("N memories have no known date — they
  stay in search and related memories rather than being placed here"),
  and they remain fully reachable via search, related memories, and
  their own pages. This preserves the Phase 4 distinction between
  event dates and kept-date proxies ("Summer 2024" never silently
  becomes "June 1, 2024").
- **Timeline grouping**: years run newest-first, months newest-first,
  entries within a month chronological (a journal page). Deleted
  memories disappear from the timeline automatically (cascade);
  inactive ones are filtered by status.

## 5. Derived relationships (no new intelligence)

- **Related topics/people** on detail pages and list rows: entities
  that share recent memories with the subject (co-occurrence),
  bounded to the subject's most recent 100 memories (detail) or 10
  (list rows). Descriptive only — no ranking of the user's life.
- **Connections**: the EXPLICIT graph edges touching the entity
  (`getEntityRelations`), endpoints resolved to labels. Relation
  endpoints link onward — memories to memory pages, entities to their
  own surfaces. No fake relationships, ever.
- **"More like this"** (memory detail): neighbors found through shared
  saved things. The memory's entities seed a bounded per-entity probe
  (20 recent memory ids each); candidates score by shared-entity
  count, then kept-date; the top 6 are shown, each naming the
  entities it shares ("shares Ahmed · Website Project"). Semantic
  vectors remain deferred — when pgvector lands, this can grow a
  semantic signal behind the same interface.

## 6. Scoped chat entry points (spec §13)

Every meaningful context page reaches the EXISTING chat pipeline —
one planner, one set of retrievers, no second engine:

- Memory detail → "Ask about this memory" (`scope=memory`) — Phase 5
- Person detail → "Talk about <name>" (`scope=entity`) — Phase 6 surface
- Topic detail → "Talk about <topic>" (`scope=entity`) — Phase 6 surface
- Timeline → "Ask about this period" (global scope; the planner
  handles the time range from the question itself — the timeline UI
  implements no special reasoning)
- Search entity-scoped view → unchanged ("Chat about …")

The timeline filter links (`/timeline?entity=<id>`, "View in timeline"
on detail pages) are plain navigational filters — they pass ids, not
intent, and cannot bypass the planner.

## 7. Discovery

The Memories page shows a quiet strip: "People you mention" and
"Topics you've written about", top 6 each with plain counts. Rules:
descriptive only, no judgmental labels, no rankings of the user's
life, hidden while searching, hidden entirely when there is nothing
to describe. Zero-count entities never appear.

## 8. API surface

**No new REST endpoints were needed.** All exploration surfaces are
React Server Components reading the exploration services directly;
client interactivity is limited to the existing AskBox and theme
toggle. Per spec §22 ("add only APIs that are actually needed"), the
services themselves — `listPeople`, `listTopics`, `getEntityDetail`,
`getTimeline`, `getSimilarMemories`, `getDiscovery` — are the API, and
REST wrappers can be added later without redesign if a non-RSC client
ever appears. Search and chat continue using the existing
`GET /api/search` and `POST /api/chat`.

## 9. Performance rules (binding)

- Pages, not scans: every list paginates at the link or row level.
- Aggregates, not loads: counts come from `groupBy`; the detail page
  never loads all of an entity's memories to count them.
- Bounded probes: co-occurrence windows (100/10), similar-memory
  probes (20/entity, top 6 out), timeline cap (60) — all constants in
  `exploration-service.ts` with rationale comments.
- No client-side mega-payloads: server components render bounded
  pages; nothing ships "every memory" to the browser.

## 10. Empty, loading, and error states

- Empty states use the shared `EmptyState` with the spec's honest
  wording ("You haven't saved memories mentioning people yet." /
  "No topics have emerged yet." / "There aren't enough dated memories
  to build a timeline yet."). No demo content.
- Loading states are skeletons shaped like what arrives
  (`loading.tsx` per route; no "AI is thinking" — nothing here is AI).
- Errors fall to the existing global error boundary (calm message +
  retry); foreign/unknown entity ids render `notFound()` — existence
  is not information one user gets about another.

## 11. Current limitations (stated honestly)

- Related topics/people derive from RECENT memories only; a topic a
  person appeared with long ago may not surface. The alternative —
  scanning every memory — would violate the bounds; the trade is
  deliberate.
- Discovery scans at most the 200 most recently created entities per
  type; beyond that pool, "most mentioned" is approximated within it.
- Timeline pagination is memory-granular (20 per page), not
  month-granular; a dense month may split across pages.
- No REST endpoints (§8) — by design until a client needs them.
- Semantic similarity remains deferred everywhere (see
  `docs/memory-system.md` §13); "more like this" is entity-based.

## 12. Authentication (Phase 7)

Every exploration surface is a server component that resolves the
authenticated user first (`requirePageUser()`) — anonymous visitors go
calmly to `/login`, and the surfaces render one account's graph only.
Nothing else changed: the derivations were already user-scoped by
construction, the pages already trusted no client state, and scoped
chat entry points run through the same session-gated ask pipeline.
