/**
 * Exploration module — wandering through what you've kept.
 *
 * Turns the existing memory graph into human-facing navigation:
 * People, Topics, and a Timeline, plus the quiet connections between
 * memories ("more like this", related topics, related people).
 *
 * Owns:
 *  - the People and Topics indexes and detail pages' data
 *  - the global timeline (dated memories grouped by month/year)
 *  - shared-appearance derivations (related topics/people, similar
 *    memories) — each suggestion can name why it appeared
 *  - the discovery strip (who and what appear in your memories)
 *
 * Depends on:
 *  - `modules/memory`, `modules/entity` (public APIs only)
 *
 * Boundary rules:
 *  - No AI anywhere in this module: exploration is deterministic
 *    database derivation. Where a query is enough, a query is what
 *    happens.
 *  - No new retrieval engine: this module composes the existing
 *    modules' read helpers; the Query Planner and Retrievers remain
 *    the only paths from a question to memories.
 *  - Ownership is structural (every call carries the userId).
 *  - Honest dates: only known event dates reach the timeline; the
 *    kept-date is never presented as an event date.
 */

export {
  listPeople,
  listTopics,
  getEntityDetail,
  getTimeline,
  getSimilarMemories,
  getDiscovery,
  ENTITY_PAGE_SIZE,
  MEMORY_PAGE_SIZE,
  type TimelinePageData,
} from "./application/exploration-service";
