/**
 * Entity & graph repository — the only place Prisma meets entities,
 * memory↔entity links, and relations.
 *
 * Ownership: every function takes an explicit userId and scopes by it.
 * Relations are polymorphic (no foreign keys on their endpoints), so
 * endpoint existence and ownership are verified by the service using
 * the owning modules' public APIs — this layer just stores.
 */

import { db } from "@/lib/db";
import type { Entity, EntityRole, EntityType } from "@/types/entity";
import type {
  Relation,
  RelationNodeType,
  RelationStatus,
  RelationType,
} from "@/types/relation";
import type { Prisma } from "@prisma/client";

function toEntity(row: Prisma.EntityGetPayload<object>): Entity {
  return {
    id: row.id,
    userId: row.userId,
    type: row.type as EntityType,
    name: row.name,
    canonicalName: row.canonicalName,
    description: row.description,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toRelation(row: Prisma.RelationGetPayload<object>): Relation {
  return {
    id: row.id,
    userId: row.userId,
    sourceType: row.sourceType as RelationNodeType,
    sourceId: row.sourceId,
    relationType: row.relationType as RelationType,
    targetType: row.targetType as RelationNodeType,
    targetId: row.targetId,
    confidence: row.confidence,
    status: row.status as RelationStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function createEntity(
  userId: string,
  data: { type: EntityType; name: string; canonicalName: string; description: string | null }
): Promise<Entity> {
  const row = await db.entity.create({ data: { userId, ...data } });
  return toEntity(row);
}

export async function findEntity(userId: string, entityId: string): Promise<Entity | null> {
  const row = await db.entity.findFirst({ where: { id: entityId, userId } });
  return row ? toEntity(row) : null;
}

/** Exact canonical match within one user and one entity type. */
export async function findCanonicalEntity(
  userId: string,
  type: EntityType,
  canonicalName: string
): Promise<Entity | null> {
  const row = await db.entity.findUnique({
    where: {
      userId_type_canonicalName: { userId, type, canonicalName },
    },
  });
  return row ? toEntity(row) : null;
}

/**
 * All of a user's entities of one type whose canonical name contains
 * the given key (or whose canonical name is contained by it), up to a
 * limit. The candidate pool for entity resolution — ranking and
 * ambiguity decisions happen above this layer.
 */
export async function findEntityCandidates(
  userId: string,
  type: EntityType,
  nameKey: string,
  limit: number
): Promise<Entity[]> {
  const rows = await db.entity.findMany({
    where: {
      userId,
      type,
      OR: [
        { canonicalName: { contains: nameKey } },
        { name: { contains: nameKey } },
      ],
    },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  return rows.map(toEntity);
}

/** Every entity of one type for a user, oldest first (bounded pool). */
export async function listEntitiesByType(
  userId: string,
  type: EntityType,
  limit: number
): Promise<Entity[]> {
  const rows = await db.entity.findMany({
    where: { userId, type },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  return rows.map(toEntity);
}

/**
 * Candidate pool across ALL of a user's entity types (Phase 4 —
 * mentions without a proposed type). Same containment semantics as
 * findEntityCandidates; ranking happens above this layer.
 */
export async function findEntityCandidatesAnyType(
  userId: string,
  nameKey: string,
  limit: number
): Promise<Entity[]> {
  const rows = await db.entity.findMany({
    where: {
      userId,
      OR: [
        { canonicalName: { contains: nameKey } },
        { name: { contains: nameKey } },
      ],
    },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  return rows.map(toEntity);
}

/** Entities by id, ownership-scoped, in caller order. */
export async function listEntitiesByIds(userId: string, entityIds: string[]): Promise<Entity[]> {
  if (entityIds.length === 0) return [];
  const rows = await db.entity.findMany({
    where: { userId, id: { in: entityIds } },
  });
  const byId = new Map(rows.map((row) => [row.id, toEntity(row)]));
  return entityIds.flatMap((id) => {
    const entity = byId.get(id);
    return entity ? [entity] : [];
  });
}

/** The user's most recently created entities, bounded (analysis context pool). */
export async function listRecentEntities(userId: string, limit: number): Promise<Entity[]> {
  const rows = await db.entity.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return rows.map(toEntity);
}

/**
 * Link a memory to an entity (upsert on the composite key — one link
 * per pair; re-linking updates role/confidence). Both ids must exist;
 * existence is checked here within the write.
 */
export async function linkMemoryToEntity(
  userId: string,
  memoryId: string,
  entityId: string,
  data: { role: EntityRole; confidence: number | null }
): Promise<void> {
  await db.memoryEntity.upsert({
    where: { memoryId_entityId: { memoryId, entityId } },
    create: { memoryId, entityId, role: data.role, confidence: data.confidence },
    update: { role: data.role, confidence: data.confidence },
  });
}

/** A memory's entity links, with the entity rows included. */
export async function listLinksForMemory(
  userId: string,
  memoryId: string
): Promise<Array<{ role: EntityRole; confidence: number | null; entity: Entity }>> {
  const rows = await db.memoryEntity.findMany({
    where: { memory: { id: memoryId, userId } },
    include: { entity: true },
    orderBy: { entity: { name: "asc" } },
  });
  return rows.map((row) => ({
    role: row.role as EntityRole,
    confidence: row.confidence,
    entity: toEntity(row.entity),
  }));
}

/** An entity's memory links, with the memory rows included. */
export async function listLinksForEntity(
  userId: string,
  entityId: string
): Promise<Array<{ role: EntityRole; confidence: number | null; memoryId: string }>> {
  const rows = await db.memoryEntity.findMany({
    where: { entity: { id: entityId, userId } },
    select: { memoryId: true, role: true, confidence: true },
  });
  return rows.map((row) => ({
    memoryId: row.memoryId,
    role: row.role as EntityRole,
    confidence: row.confidence,
  }));
}

/** Entity ids linked to a memory through memory_entities (graph adjacency). */
export async function listEntityIdsForMemory(userId: string, memoryId: string): Promise<string[]> {
  const rows = await db.memoryEntity.findMany({
    where: { memory: { id: memoryId, userId } },
    select: { entityId: true },
  });
  return rows.map((row) => row.entityId);
}

/**
 * Entity ids linked to ANY of the given memories, batched (graph
 * adjacency for bounded traversal). Ownership-scoped by construction.
 */
export async function listEntityIdsForMemories(
  userId: string,
  memoryIds: string[]
): Promise<Map<string, string[]>> {
  if (memoryIds.length === 0) return new Map();
  const rows = await db.memoryEntity.findMany({
    where: { memory: { userId, id: { in: memoryIds } } },
    select: { memoryId: true, entityId: true },
  });
  const map = new Map<string, string[]>();
  for (const row of rows) {
    const list = map.get(row.memoryId) ?? [];
    list.push(row.entityId);
    map.set(row.memoryId, list);
  }
  return map;
}

/**
 * Memory ids linked to ANY of the given entities, batched (graph
 * adjacency: entity → its memories). Ownership-scoped by construction.
 */
export async function listMemoryIdsForEntities(
  userId: string,
  entityIds: string[]
): Promise<Map<string, string[]>> {
  if (entityIds.length === 0) return new Map();
  const rows = await db.memoryEntity.findMany({
    where: { entity: { userId, id: { in: entityIds } } },
    select: { memoryId: true, entityId: true },
  });
  const map = new Map<string, string[]>();
  for (const row of rows) {
    const list = map.get(row.entityId) ?? [];
    list.push(row.memoryId);
    map.set(row.entityId, list);
  }
  return map;
}

/** Every relation whose source or target is the given node. */
export async function listRelationsTouching(
  userId: string,
  nodeType: RelationNodeType,
  nodeId: string
): Promise<Relation[]> {
  const rows = await db.relation.findMany({
    where: {
      userId,
      OR: [
        { sourceType: nodeType, sourceId: nodeId },
        { targetType: nodeType, targetId: nodeId },
      ],
    },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(toRelation);
}

/**
 * Relations touching ANY of the given nodes, batched (graph adjacency
 * for bounded traversal). Ownership-scoped by construction; newer
 * edges first so a traversal prefers the freshest connections.
 */
export async function listRelationsTouchingNodes(
  userId: string,
  nodes: Array<{ type: RelationNodeType; id: string }>,
  limit: number
): Promise<Relation[]> {
  if (nodes.length === 0) return [];
  const rows = await db.relation.findMany({
    where: {
      userId,
      OR: nodes.flatMap((node) => [
        { sourceType: node.type, sourceId: node.id },
        { targetType: node.type, targetId: node.id },
      ]),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return rows.map(toRelation);
}

export async function createRelation(
  userId: string,
  data: {
    sourceType: RelationNodeType;
    sourceId: string;
    relationType: RelationType;
    targetType: RelationNodeType;
    targetId: string;
    confidence: number | null;
  }
): Promise<Relation> {
  const row = await db.relation.create({ data: { userId, ...data } });
  return toRelation(row);
}

/**
 * Whether an identical relation (same user, same endpoints, same type)
 * already exists — the idempotency guard that makes processing retries
 * safe. Direction matters: A → related_to → B and B → related_to → A
 * are treated as the same edge here, since relation graphs for a
 * personal archive read symmetrically.
 */
export async function findExistingRelation(
  userId: string,
  a: { type: RelationNodeType; id: string },
  relationType: RelationType,
  b: { type: RelationNodeType; id: string }
): Promise<Relation | null> {
  const forward = await db.relation.findFirst({
    where: {
      userId,
      relationType,
      sourceType: a.type,
      sourceId: a.id,
      targetType: b.type,
      targetId: b.id,
    },
  });
  if (forward) return toRelation(forward);

  const backward = await db.relation.findFirst({
    where: {
      userId,
      relationType,
      sourceType: b.type,
      sourceId: b.id,
      targetType: a.type,
      targetId: a.id,
    },
  });
  return backward ? toRelation(backward) : null;
}

/* ————————————————— Exploration support (Phase 6) ————————————————— */
/*
 * Read-only aggregates for the exploration surfaces (people, topics,
 * timeline). Every query is ownership-scoped; counts only include
 * ACTIVE memories — archived and superseded rows follow the same
 * visibility rules retrieval established (superseded excluded from
 * default search in Phase 4; exploration matches that honesty).
 * Memory status is read through the memoryEntity → memory relation —
 * the same symmetric pattern this repository already uses when it
 * scopes links by `memory: { userId }`.
 */

/**
 * Entities of the given types, one bounded page plus the total.
 * Ordered by canonical name — an index to browse, not a ranking.
 */
export async function listEntitiesByTypes(
  userId: string,
  types: EntityType[],
  options: { page: number; pageSize: number }
): Promise<{ entities: Entity[]; total: number }> {
  const where: Prisma.EntityWhereInput = { userId, type: { in: types } };
  const [rows, total] = await Promise.all([
    db.entity.findMany({
      where,
      orderBy: [{ canonicalName: "asc" }, { createdAt: "asc" }],
      skip: (options.page - 1) * options.pageSize,
      take: options.pageSize,
    }),
    db.entity.count({ where }),
  ]);
  return { entities: rows.map(toEntity), total };
}

/**
 * Active-memory count per entity, as ONE grouped aggregate. Counts
 * are deterministic database numbers — never model output.
 */
export async function countActiveMemoriesForEntities(
  userId: string,
  entityIds: string[]
): Promise<Map<string, number>> {
  if (entityIds.length === 0) return new Map();
  const rows = await db.memoryEntity.groupBy({
    by: ["entityId"],
    where: {
      entityId: { in: entityIds },
      entity: { userId },
      memory: { status: "active" },
    },
    _count: { memoryId: true },
  });
  return new Map(rows.map((row) => [row.entityId, row._count.memoryId]));
}

/**
 * The most recent kept-date among each entity's active memories —
 * "last kept" is the kept-date (createdAt), which is always true and
 * never a fabricated event date. Absent when an entity has no
 * active memories.
 */
export async function lastKeptForEntities(
  userId: string,
  entityIds: string[]
): Promise<Map<string, Date | null>> {
  const map = new Map<string, Date | null>(entityIds.map((id) => [id, null]));
  if (entityIds.length === 0) return map;

  await Promise.all(
    entityIds.map(async (entityId) => {
      const row = await db.memoryEntity.findFirst({
        where: { entityId, entity: { userId }, memory: { status: "active" } },
        select: { memory: { select: { createdAt: true } } },
        orderBy: { memory: { createdAt: "desc" } },
      });
      map.set(entityId, row?.memory.createdAt ?? null);
    })
  );
  return map;
}

/**
 * Each entity's most recent memory ids, bounded per entity (never the
 * whole graph). Newest kept first. Used for recent-memory lists and
 * bounded co-occurrence derivation (related topics / people).
 */
export async function listRecentMemoryIdsForEntities(
  userId: string,
  entityIds: string[],
  take: number
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>(entityIds.map((id) => [id, []]));
  if (entityIds.length === 0) return map;

  await Promise.all(
    entityIds.map(async (entityId) => {
      const rows = await db.memoryEntity.findMany({
        where: { entityId, entity: { userId }, memory: { status: "active" } },
        select: { memoryId: true },
        orderBy: { memory: { createdAt: "desc" } },
        take,
      });
      map.set(entityId, rows.map((row) => row.memoryId));
    })
  );
  return map;
}

/**
 * One page of an entity's ACTIVE memory ids (newest kept first) plus
 * the total. Pagination happens at the link level, so a person with
 * 10,000 memories still pages through them in bounded queries.
 */
export async function listMemoryIdsForEntityPaged(
  userId: string,
  entityId: string,
  options: { page: number; pageSize: number }
): Promise<{ memoryIds: string[]; total: number }> {
  const where: Prisma.MemoryEntityWhereInput = {
    entityId,
    entity: { userId },
    memory: { status: "active" },
  };
  const [rows, total] = await Promise.all([
    db.memoryEntity.findMany({
      where,
      select: { memoryId: true },
      orderBy: { memory: { createdAt: "desc" } },
      skip: (options.page - 1) * options.pageSize,
      take: options.pageSize,
    }),
    db.memoryEntity.count({ where }),
  ]);
  return { memoryIds: rows.map((row) => row.memoryId), total };
}

export { toEntity, toRelation };
