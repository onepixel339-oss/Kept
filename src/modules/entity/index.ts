/**
 * Entity module — the people, places, and things inside memories, and
 * the graph that connects everything.
 *
 * Owns:
 *  - Entities and their canonical identity (exact-match reuse, plus —
 *    since Phase 3 — the deterministic candidate pool the intelligence
 *    module's resolution layer decides on: deep normalization,
 *    conservative alias comparison, ambiguity detection)
 *  - Explicit memory ↔ entity links (memory_entities)
 *  - The polymorphic relation graph (memory↔memory, memory↔entity,
 *    entity↔entity) — storage, safe creation, and idempotency checks;
 *    traversal belongs to a later phase
 *
 * Depends on:
 *  - `modules/memory` (public API only — dependency is one-way)
 *  - `@/lib/db`, `@/lib/api`
 *
 * Boundary rules: other modules consume entities and relations ONLY
 * through this file's exports. AI never writes here directly — the
 * intelligence pipeline passes validated proposals through these
 * functions, and the functions keep enforcing ownership.
 *
 * Phase 4: additive read-only retrieval support — batched graph
 * adjacency (memory↔entity ids, relations by node), candidate search
 * across types (mentions without a proposed type), and entities by
 * id. Traversal itself lives in modules/query.
 */

export {
  createEntity,
  getEntity,
  linkMemoryEntity,
  createRelation,
  getMemoryGraph,
  getRelatedMemories,
  getEntityMemories,
  getEntityRelations,
  findEntityCandidatesByName,
  relationExists,
  listRecentEntities,
  listEntityIdsForMemory,
  listEntityIdsForMemories,
  listMemoryIdsForEntities,
  listRelationsTouchingNodes,
  findEntitiesByIds,
  type EntityCandidate,
  type EntityMatchBasis,
} from "./application/entity-service";

/*
 * Phase 6 — exploration support (read-only aggregates for the
 * People / Topics / Timeline surfaces). Counts and recency are
 * deterministic database derivations; ownership stays structural.
 */
export {
  listEntitiesByTypes,
  countActiveMemoriesForEntities,
  lastKeptForEntities,
  listRecentMemoryIdsForEntities,
  listMemoryIdsForEntityPaged,
} from "./application/entity-service";

export {
  canonicalizeName,
  normalizeNameDeep,
  transliterateToLatin,
} from "./domain/entity-rules";
