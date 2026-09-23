/**
 * Entity application services — entities, memory↔entity links, and
 * the relation graph, behind one public surface.
 *
 * Ownership rules enforced here:
 *  - Entities are scoped by userId on every read and write.
 *  - Relations belong to their creator; both endpoints must exist AND
 *    belong to the same user before a relation is written. No
 *    cross-user edges, ever.
 *  - "Not found" is returned for other users' ids — existence is not
 *    information one user gets about another.
 *
 * The memory module is consumed through its public API only
 * (findMemory), keeping the dependency direction one-way:
 * entity → memory.
 *
 * Phase 2 stores and manages the graph. Intelligent entity resolution
 * and graph traversal are deferred to later phases.
 */

import { AppError } from "@/lib/api";
import { snippet } from "@/lib/format";
import type { Entity, EntityRole, EntityType } from "@/types/entity";
import type {
  Relation,
  RelationNodeType,
  RelationType,
  ResolvedRelation,
} from "@/types/relation";
import type { Memory } from "@/types/memory";
import {
  canonicalizeName,
  normalizeNameDeep,
  transliterateToLatin,
} from "../domain/entity-rules";
import {
  createEntitySchema,
  createRelationSchema,
  entityIdSchema,
  linkMemoryEntitySchema,
} from "./validation";
import * as repo from "../infrastructure/entity-repository";
import { findMemory } from "@/modules/memory";

function assertEntityId(entityId: string): void {
  const parsed = entityIdSchema.safeParse(entityId);
  if (!parsed.success) {
    throw new AppError("not_found", "That entity could not be found.");
  }
}

function requireEntity(entity: Entity | null): Entity {
  if (!entity) {
    throw new AppError("not_found", "That entity could not be found.");
  }
  return entity;
}

/**
 * Create an entity, or return the existing one on an exact canonical
 * match (same user, same type, same canonical name). Ambiguous
 * matches — same name, different type — are separate entities and are
 * never merged silently.
 */
export async function createEntity(
  userId: string,
  input: unknown
): Promise<{ entity: Entity; reused: boolean }> {
  const data = createEntitySchema.parse(input);
  const canonicalName = canonicalizeName(data.name);

  const existing = await repo.findCanonicalEntity(userId, data.type, canonicalName);
  if (existing) {
    return { entity: existing, reused: true };
  }

  const entity = await repo.createEntity(userId, {
    type: data.type,
    name: data.name,
    canonicalName,
    description: data.description ?? null,
  });
  return { entity, reused: false };
}

/** Read one entity. Cross-user reads look exactly like missing ones. */
export async function getEntity(userId: string, entityId: string): Promise<Entity> {
  assertEntityId(entityId);
  return requireEntity(await repo.findEntity(userId, entityId));
}

/**
 * Link a memory to an entity. Both must exist and belong to the user.
 * Re-linking an existing pair updates its role and confidence.
 */
export async function linkMemoryEntity(
  userId: string,
  memoryId: string,
  entityId: string,
  input: unknown = {}
): Promise<void> {
  assertEntityId(entityId);
  const data = linkMemoryEntitySchema.parse(input);

  const memory = await findMemory(userId, memoryId);
  if (!memory) {
    throw new AppError("not_found", "That memory could not be found.");
  }
  const entity = await repo.findEntity(userId, entityId);
  if (!entity) {
    throw new AppError("not_found", "That entity could not be found.");
  }

  await repo.linkMemoryToEntity(userId, memoryId, entityId, {
    role: data.role,
    confidence: data.confidence ?? null,
  });
}

/** Resolve human labels for relation endpoints (memories and entities). */
async function resolveRelation(
  userId: string,
  relation: Relation
): Promise<ResolvedRelation> {
  const [sourceLabel, targetLabel] = await Promise.all([
    describeEndpoint(userId, relation.sourceType, relation.sourceId),
    describeEndpoint(userId, relation.targetType, relation.targetId),
  ]);
  return { relation, sourceLabel, targetLabel };
}

async function describeEndpoint(
  userId: string,
  nodeType: RelationNodeType,
  nodeId: string
): Promise<string | null> {
  if (nodeType === "memory") {
    const memory: Memory | null = await findMemory(userId, nodeId);
    if (!memory) return null;
    return memory.title ?? snippet(memory.originalContent, 60);
  }
  const entity = await repo.findEntity(userId, nodeId);
  return entity?.name ?? null;
}

/**
 * Create a relation between two of the user's own nodes. Endpoints
 * are verified for existence and ownership before the write; a
 * relation never bridges two users.
 */
export async function createRelation(userId: string, input: unknown): Promise<Relation> {
  const data = createRelationSchema.parse(input);

  const endpoints = [
    { type: data.sourceType, id: data.sourceId },
    { type: data.targetType, id: data.targetId },
  ] as const;

  for (const endpoint of endpoints) {
    if (endpoint.type === "memory") {
      const memory = await findMemory(userId, endpoint.id);
      if (!memory) {
        throw new AppError("not_found", "One of the related memories does not exist.");
      }
    } else {
      const entity = await repo.findEntity(userId, endpoint.id);
      if (!entity) {
        throw new AppError("not_found", "One of the related entities does not exist.");
      }
    }
  }

  return repo.createRelation(userId, {
    sourceType: data.sourceType,
    sourceId: data.sourceId,
    relationType: data.relationType,
    targetType: data.targetType,
    targetId: data.targetId,
    confidence: data.confidence ?? null,
  });
}

/** Everything graph-shaped about one memory, for the Memory Detail page. */
export async function getMemoryGraph(
  userId: string,
  memoryId: string
): Promise<{
  links: Array<{ role: EntityRole; confidence: number | null; entity: Entity }>;
  relations: ResolvedRelation[];
}> {
  const [links, relations] = await Promise.all([
    repo.listLinksForMemory(userId, memoryId),
    listRelationsTouching(userId, "memory", memoryId),
  ]);
  return { links, relations };
}

/** Relations touching an entity, endpoints resolved into labels. */
export async function listRelationsTouching(
  userId: string,
  nodeType: RelationNodeType,
  nodeId: string
): Promise<ResolvedRelation[]> {
  const relations = await repo.listRelationsTouching(userId, nodeType, nodeId);
  return Promise.all(relations.map((relation) => resolveRelation(userId, relation)));
}

/** The memories connected to an entity through explicit relations. */
export async function getRelatedMemories(
  userId: string,
  entityId: string
): Promise<Array<{ memoryId: string; relationType: Relation["relationType"]; direction: "from" | "to" }>> {
  assertEntityId(entityId);
  requireEntity(await repo.findEntity(userId, entityId));

  const relations = await repo.listRelationsTouching(userId, "entity", entityId);
  return relations
    .map((relation) => {
      if (relation.sourceType === "memory" && relation.targetType === "entity") {
        return { memoryId: relation.sourceId, relationType: relation.relationType, direction: "from" as const };
      }
      if (relation.sourceType === "entity" && relation.targetType === "memory") {
        return { memoryId: relation.targetId, relationType: relation.relationType, direction: "to" as const };
      }
      return null;
    })
    .filter((entry): entry is { memoryId: string; relationType: Relation["relationType"]; direction: "from" | "to" } => entry !== null);
}

/** Memories linked to an entity through memory_entities (direct mentions). */
export async function getEntityMemories(
  userId: string,
  entityId: string
): Promise<Array<{ memoryId: string; role: EntityRole }>> {
  assertEntityId(entityId);
  requireEntity(await repo.findEntity(userId, entityId));
  return repo.listLinksForEntity(userId, entityId);
}

/** Relations touching an entity (the dedicated entity endpoint). */
export async function getEntityRelations(
  userId: string,
  entityId: string
): Promise<ResolvedRelation[]> {
  assertEntityId(entityId);
  requireEntity(await repo.findEntity(userId, entityId));
  return listRelationsTouching(userId, "entity", entityId);
}

/* ————————————————— Entity resolution support (Phase 3) ————————————————— */

/** How a candidate entity matched a proposed name. */
export type EntityMatchBasis = "exact" | "normalized" | "alias" | "partial";

export interface EntityCandidate {
  entity: Entity;
  basis: EntityMatchBasis;
}

/** Vowel-insensitive Latin key: "ahmed" → "hmd", "amr" → "mr". Used ONLY for gated alias matching. */
function looseLatinKey(value: string): string {
  return value.replace(/[aeiou]/g, "");
}

/**
 * The candidate pool for resolving one proposed entity name, ranked
 * deterministic-first. Never merges, never creates — returns evidence
 * for the resolution layer to decide on:
 *
 *   exact      canonical name equals the canonicalized proposal
 *   normalized deep-normalized equality (diacritics, Arabic letters, case)
 *   alias      the conservative Arabic→Latin transliteration matches
 *              (vowel-insensitive: أحمد "ahmd" ↔ Ahmed "ahmed")
 *   partial    substring containment (weakest signal, never auto-applied)
 *
 * Bounded by the caller's limit; scoped to the user. `type` narrows
 * the pool when the proposal carries one; null searches across ALL of
 * the user's entity types (Phase 4 — mentions without a proposed
 * type). Ambiguity (several equally strong candidates) is resolved
 * ABOVE this function — the pool's job is only to be complete.
 */
export async function findEntityCandidatesByName(
  userId: string,
  input: { type: EntityType | null; name: string; limit?: number }
): Promise<EntityCandidate[]> {
  const limit = input.limit ?? 10;
  const canonical = canonicalizeName(input.name);
  const deep = normalizeNameDeep(input.name);
  const latin = transliterateToLatin(input.name);
  const latinLoose = looseLatinKey(latin);
  const inputHasArabic = /[\u0600-\u06FF]/.test(input.name);

  const nameKey = deep === "" ? canonical : deep.split(" ")[0];
  const pool = input.type
    ? await repo.findEntityCandidates(userId, input.type, nameKey, limit * 3)
    : await repo.findEntityCandidatesAnyType(userId, nameKey, limit * 3);

  const candidates: EntityCandidate[] = [];
  let poolRep = pool;
  if (pool.length === 0 && deep !== "") {
    // Fall back to the widest bounded pool so alias and partial
    // matching still see candidates when containment fails.
    poolRep = input.type
      ? await repo.listEntitiesByType(userId, input.type, limit * 3)
      : await repo.listRecentEntities(userId, limit * 3);
  }

  for (const entity of poolRep) {
    const entityCanonical = entity.canonicalName;
    const entityDeep = normalizeNameDeep(entity.name);
    const entityLatin = transliterateToLatin(entity.name);

    let basis: EntityMatchBasis | null = null;
    if (entityCanonical === canonical) basis = "exact";
    else if (entityDeep !== "" && entityDeep === deep) basis = "normalized";
    else if (
      latinLoose !== "" &&
      looseLatinKey(entityLatin) === latinLoose &&
      (inputHasArabic || /[\u0600-\u06FF]/.test(entity.name))
    ) {
      // Alias: the conservative transliteration matches across scripts
      // (أحمد ↔ Ahmed), vowel-insensitively. Only meaningful when one
      // side is Arabic script, and still gated by AI confidence above.
      basis = "alias";
    } else if (entityDeep !== "" && deep !== "" && (entityDeep.includes(deep) || deep.includes(entityDeep))) {
      basis = "partial";
    }

    if (basis) candidates.push({ entity, basis });
  }

  const rank: Record<EntityMatchBasis, number> = { exact: 0, normalized: 1, alias: 2, partial: 3 };
  candidates.sort((a, b) => rank[a.basis] - rank[b.basis]);
  return candidates.slice(0, limit);
}

/**
 * Whether an identical relation already exists (idempotency guard for
 * processing retries). Ownership-scoped, direction-insensitive.
 */
export async function relationExists(
  userId: string,
  a: { type: RelationNodeType; id: string },
  relationType: RelationType,
  b: { type: RelationNodeType; id: string }
): Promise<boolean> {
  return (await repo.findExistingRelation(userId, a, relationType, b)) !== null;
}

/** The user's most recently created entities, bounded (analysis context pool). */
export async function listRecentEntities(userId: string, limit = 10): Promise<Entity[]> {
  return repo.listRecentEntities(userId, limit);
}

/* ————————————————— Retrieval support (Phase 4) ————————————————— */

/** Entity ids linked to a memory through memory_entities (graph adjacency). */
export async function listEntityIdsForMemory(userId: string, memoryId: string): Promise<string[]> {
  return repo.listEntityIdsForMemory(userId, memoryId);
}

/** Entity ids linked to any of the given memories, batched (graph adjacency). */
export async function listEntityIdsForMemories(
  userId: string,
  memoryIds: string[]
): Promise<Map<string, string[]>> {
  return repo.listEntityIdsForMemories(userId, memoryIds);
}

/** Memory ids linked to any of the given entities, batched (graph adjacency). */
export async function listMemoryIdsForEntities(
  userId: string,
  entityIds: string[]
): Promise<Map<string, string[]>> {
  return repo.listMemoryIdsForEntities(userId, entityIds);
}

/**
 * Raw relations touching any of the given nodes (batched, bounded).
 * The graph retriever's adjacency — labels are resolved later, only
 * for the small set of edges that enter the context.
 */
export async function listRelationsTouchingNodes(
  userId: string,
  nodes: Array<{ type: RelationNodeType; id: string }>,
  limit: number
): Promise<Relation[]> {
  return repo.listRelationsTouchingNodes(userId, nodes, limit);
}

/** Entities by id, ownership-scoped, caller order (context builder). */
export async function findEntitiesByIds(userId: string, entityIds: string[]): Promise<Entity[]> {
  return repo.listEntitiesByIds(userId, entityIds);
}

/* ————————————————— Exploration support (Phase 6) ————————————————— */
/*
 * Read-only aggregates for the exploration surfaces. These are plain
 * database derivations — no AI, no ranking judgment — with ownership
 * scoped inside every query. Counts cover ACTIVE memories only;
 * "last kept" is the kept-date, never a fabricated event date.
 */

/** One page of the user's entities of the given types, with the total. */
export async function listEntitiesByTypes(
  userId: string,
  types: EntityType[],
  options: { page: number; pageSize: number }
): Promise<{ entities: Entity[]; total: number }> {
  if (types.length === 0) return { entities: [], total: 0 };
  return repo.listEntitiesByTypes(userId, types, options);
}

/** Active-memory counts per entity (deterministic database aggregates). */
export async function countActiveMemoriesForEntities(
  userId: string,
  entityIds: string[]
): Promise<Map<string, number>> {
  return repo.countActiveMemoriesForEntities(userId, entityIds);
}

/** Most recent kept-date per entity (null when no active memories). */
export async function lastKeptForEntities(
  userId: string,
  entityIds: string[]
): Promise<Map<string, Date | null>> {
  return repo.lastKeptForEntities(userId, entityIds);
}

/** Most recent memory ids per entity, bounded per entity. */
export async function listRecentMemoryIdsForEntities(
  userId: string,
  entityIds: string[],
  take: number
): Promise<Map<string, string[]>> {
  return repo.listRecentMemoryIdsForEntities(userId, entityIds, take);
}

/**
 * One page of an entity's ACTIVE memory ids, newest kept first, with
 * the total. The entity detail pages' memory list — pagination stays
 * bounded no matter how many memories an entity accumulates.
 */
export async function listMemoryIdsForEntityPaged(
  userId: string,
  entityId: string,
  options: { page: number; pageSize: number }
): Promise<{ memoryIds: string[]; total: number }> {
  return repo.listMemoryIdsForEntityPaged(userId, entityId, options);
}
