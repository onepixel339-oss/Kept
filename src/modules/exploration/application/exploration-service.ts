/**
 * Exploration application services — the People / Topics / Timeline
 * surfaces' data layer.
 *
 * This module creates nothing and understands nothing on its own: it
 * DERIVES everything from stored data through the memory and entity
 * modules' public APIs (no cross-module Prisma, no AI, no new
 * retrieval engine). Counts are database aggregates; dates are dates
 * memories actually carry; suggestions ("more like this", related
 * topics) are shared-appearance derivations that can always name the
 * reason they appeared.
 *
 * Boundary rules:
 *  - Ownership is structural: every call carries the userId, and the
 *    underlying module reads are scoped by it. Another user's entity
 *    looks exactly like one that does not exist.
 *  - Everything is bounded: pages, per-entity probes, timeline caps.
 *    A person with 10,000 memories pages through them; nothing loads
 *    an unbounded set.
 *  - Honest dates: the timeline only holds memories with a known
 *    event date; undated memories are counted, never placed with a
 *    fabricated date.
 */

import { snippet } from "@/lib/format";
import { TOPIC_ENTITY_TYPES, isPersonEntity, isTopicEntity } from "@/lib/entity-links";
import type { Entity, EntityType } from "@/types/entity";
import type { Memory } from "@/types/memory";
import type {
  DiscoveryData,
  EntityDetailData,
  EntityMemoryPage,
  EntitySummary,
  SimilarMemory,
  TimelineEntry,
  TimelineYear,
} from "@/types/exploration";
import {
  countActiveMemoriesForEntities,
  findEntitiesByIds,
  getEntity,
  getEntityRelations,
  lastKeptForEntities,
  listEntityIdsForMemories,
  listEntityIdsForMemory,
  listEntitiesByTypes,
  listMemoryIdsForEntityPaged,
  listRecentMemoryIdsForEntities,
} from "@/modules/entity";
import {
  countUndatedMemories,
  getMemoriesByIds,
  listDatedMemories,
} from "@/modules/memory";

/* ————————————————— Bounds ————————————————— */

/** Memories examined per entity when deriving co-occurring things. */
const COOCCURRENCE_WINDOW = 100;
/** Memories examined per entity on list pages (lighter probe). */
const SUMMARY_MEMORY_WINDOW = 10;
/** How many related topics/people to show. */
const RELATED_TAKE = 3;
/** Detail-page timeline cap (most recent dated memories). */
const DETAIL_TIMELINE_CAP = 60;
/** Per-entity probe for "more like this". */
const SIMILAR_PER_ENTITY = 20;
/** Discovery strip sizes. */
const DISCOVERY_TAKE = 6;
const DISCOVERY_POOL = 200;

export const ENTITY_PAGE_SIZE = 24;
export const MEMORY_PAGE_SIZE = 20;

function clampPage(value: number): number {
  return Math.max(1, Math.floor(value) || 1);
}

function clampPageSize(value: number, fallback: number, max = 50): number {
  return Math.min(max, Math.max(1, Math.floor(value) || fallback));
}

function toMemoryItem(memory: Memory): EntityMemoryPage["items"][number] {
  return {
    id: memory.id,
    title: memory.title,
    snippet: snippet(memory.originalContent),
    memoryType: memory.memoryType,
    status: memory.status,
    processingStatus: memory.processingStatus,
    rememberedAt: memory.rememberedAt,
    createdAt: memory.createdAt,
  };
}

/* ————————————————— Timeline grouping ————————————————— */

/**
 * Group dated memories (already ordered newest-first) into years and
 * months. Within a month, entries read chronologically — like a
 * journal page — while the months themselves run newest-first.
 */
function groupTimeline(memories: Memory[]): TimelineYear[] {
  const years = new Map<number, Map<string, TimelineEntry[]>>();

  for (const memory of memories) {
    if (!memory.rememberedAt) continue; // guarded upstream; belt and suspenders
    const date = memory.rememberedAt;
    const year = date.getFullYear();
    const key = `${year}-${String(date.getMonth() + 1).padStart(2, "0")}`;

    if (!years.has(year)) years.set(year, new Map());
    const months = years.get(year)!;
    if (!months.has(key)) months.set(key, []);
    months.get(key)!.push({
      memoryId: memory.id,
      title: memory.title,
      snippet: snippet(memory.originalContent),
      memoryType: memory.memoryType,
      date,
    });
  }

  return [...years.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([year, monthsMap]) => ({
      year,
      months: [...monthsMap.entries()]
        .sort((a, b) => (a[0] < b[0] ? 1 : -1))
        .map(([key, entries]) => {
          const sample = new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, 1);
          return {
            key,
            label: sample.toLocaleString("en-US", { month: "long" }),
            entries: entries.sort((a, b) => a.date.getTime() - b.date.getTime()),
          };
        }),
    }));
}

/* ————————————————— Co-occurrence ————————————————— */

/**
 * Things that share recent memories with the given entities — related
 * topics for a person, people for a topic. Bounded to each entity's
 * most recent memories; the derivation only ever names things that
 * actually appear together in what the user wrote.
 */
async function deriveRelated(
  userId: string,
  entityIds: string[],
  wanted: (type: EntityType) => boolean,
  memoryWindow: number,
  withCounts: boolean
): Promise<Map<string, Array<{ id: string; name: string; memoryCount: number }>>> {
  const result = new Map<string, Array<{ id: string; name: string; memoryCount: number }>>(
    entityIds.map((id) => [id, []])
  );
  if (entityIds.length === 0) return result;
  const entitySet = new Set(entityIds);

  const recent = await listRecentMemoryIdsForEntities(userId, entityIds, memoryWindow);

  const memoryIds = [...new Set([...recent.values()].flat())];
  const entitiesByMemory = memoryIds.length
    ? await listEntityIdsForMemories(userId, memoryIds)
    : new Map<string, string[]>();

  const candidateIds = [...new Set([...entitiesByMemory.values()].flat())].filter(
    (id) => !entitySet.has(id)
  );
  if (candidateIds.length === 0) return result;

  const candidates = await findEntitiesByIds(userId, candidateIds);
  const wantedEntities = candidates.filter((entity) => wanted(entity.type));
  if (wantedEntities.length === 0) return result;

  const counts = withCounts
    ? await countActiveMemoriesForEntities(
        userId,
        wantedEntities.map((entity) => entity.id)
      )
    : new Map<string, number>();

  for (const entityId of entityIds) {
    const coIds = [
      ...new Set(
        (recent.get(entityId) ?? []).flatMap((memoryId) => entitiesByMemory.get(memoryId) ?? [])
      ),
    ].filter((id) => id !== entityId);

    const related = coIds
      .map((id) => wantedEntities.find((entity) => entity.id === id))
      .filter((entity): entity is Entity => Boolean(entity))
      .slice(0, RELATED_TAKE)
      .map((entity) => ({
        id: entity.id,
        name: entity.name,
        memoryCount: counts.get(entity.id) ?? 0,
      }));

    result.set(entityId, related);
  }

  return result;
}

/* ————————————————— People & Topics lists ————————————————— */

async function listEntitySummaries(
  userId: string,
  types: EntityType[],
  options: { page: number; pageSize: number }
): Promise<{ summaries: EntitySummary[]; total: number; page: number; pageSize: number }> {
  const page = clampPage(options.page);
  const pageSize = clampPageSize(options.pageSize, ENTITY_PAGE_SIZE);

  const { entities, total } = await listEntitiesByTypes(userId, types, { page, pageSize });

  const ids = entities.map((entity) => entity.id);
  const [counts, lastKept, topics, people] = await Promise.all([
    countActiveMemoriesForEntities(userId, ids),
    lastKeptForEntities(userId, ids),
    deriveRelated(userId, ids, isTopicEntity, SUMMARY_MEMORY_WINDOW, false),
    deriveRelated(userId, ids, isPersonEntity, SUMMARY_MEMORY_WINDOW, false),
  ]);

  return {
    summaries: entities.map((entity) => ({
      entity,
      memoryCount: counts.get(entity.id) ?? 0,
      lastKeptAt: lastKept.get(entity.id) ?? null,
      relatedTopics: topics.get(entity.id) ?? [],
      relatedPeople: people.get(entity.id) ?? [],
    })),
    total,
    page,
    pageSize,
  };
}

/** The People index — every person the user's memories mention. */
export async function listPeople(
  userId: string,
  options: { page: number; pageSize: number }
): Promise<{ people: EntitySummary[]; total: number; page: number; pageSize: number }> {
  const result = await listEntitySummaries(userId, ["person"], options);
  return {
    people: result.summaries,
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
  };
}

/** The Topics index — topic and project entities (spec §4). */
export async function listTopics(
  userId: string,
  options: { page: number; pageSize: number }
): Promise<{ topics: EntitySummary[]; total: number; page: number; pageSize: number }> {
  const result = await listEntitySummaries(userId, TOPIC_ENTITY_TYPES, options);
  return {
    topics: result.summaries,
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
  };
}

/* ————————————————— Entity detail (person / topic pages) ————————————————— */

/**
 * Everything one entity's page renders, in bounded queries. A foreign
 * or unknown id throws not_found — existence is not information one
 * user gets about another.
 */
export async function getEntityDetail(
  userId: string,
  entityId: string,
  options: { page: number; pageSize: number }
): Promise<EntityDetailData> {
  // Ownership gate: throws not_found unless this entity is the user's.
  const entity = await getEntity(userId, entityId);

  const page = clampPage(options.page);
  const pageSize = clampPageSize(options.pageSize, MEMORY_PAGE_SIZE);

  const [counts, lastKept, memoryPage, topics, people, datedTimeline, connections] =
    await Promise.all([
      countActiveMemoriesForEntities(userId, [entity.id]),
      lastKeptForEntities(userId, [entity.id]),
      listMemoryIdsForEntityPaged(userId, entity.id, { page, pageSize }),
      deriveRelated(userId, [entity.id], isTopicEntity, COOCCURRENCE_WINDOW, true),
      deriveRelated(userId, [entity.id], isPersonEntity, COOCCURRENCE_WINDOW, true),
      listDatedMemories(userId, {
        entityIds: [entity.id],
        page: 1,
        pageSize: DETAIL_TIMELINE_CAP,
        order: "desc",
      }),
      getEntityRelations(userId, entity.id),
    ]);

  const memoryRows = memoryPage.memoryIds.length
    ? await getMemoriesByIds(userId, memoryPage.memoryIds)
    : [];

  return {
    entity,
    memoryCount: counts.get(entity.id) ?? 0,
    lastKeptAt: lastKept.get(entity.id) ?? null,
    memories: {
      items: memoryRows.map(toMemoryItem),
      page,
      pageSize,
      total: memoryPage.total,
    },
    topics: topics.get(entity.id) ?? [],
    people: people.get(entity.id) ?? [],
    timeline: groupTimeline(datedTimeline.memories),
    timelineTruncated: datedTimeline.total > DETAIL_TIMELINE_CAP,
    connections,
  };
}

/* ————————————————— Timeline ————————————————— */

export interface TimelinePageData {
  years: TimelineYear[];
  total: number;
  page: number;
  pageSize: number;
  /** Memories with no known event date — counted, never placed. */
  undatedCount: number;
  /** The entity the timeline is filtered by, when one is. */
  filteredEntity: Entity | null;
}

/**
 * The global timeline: the user's dated memories, newest-first,
 * grouped by year and month. Optional entity filter (a person or
 * topic). Undated memories stay off the timeline — they are counted
 * and reported instead of being placed with invented dates.
 */
export async function getTimeline(
  userId: string,
  options: { entityId?: string | null; page: number; pageSize: number }
): Promise<TimelinePageData> {
  const page = clampPage(options.page);
  const pageSize = clampPageSize(options.pageSize, MEMORY_PAGE_SIZE);

  // Ownership: a foreign filter id resolves to nothing (not an error —
  // the filter simply has nothing to show, like search's scoped view).
  const filteredEntity = options.entityId
    ? await getEntity(userId, options.entityId).catch(() => null)
    : null;

  const [{ memories, total }, undatedCount] = await Promise.all([
    listDatedMemories(userId, {
      entityIds: filteredEntity ? [filteredEntity.id] : undefined,
      page,
      pageSize,
      order: "desc",
    }),
    countUndatedMemories(userId),
  ]);

  return {
    years: groupTimeline(memories),
    total,
    page,
    pageSize,
    undatedCount,
    filteredEntity,
  };
}

/* ————————————————— More like this ————————————————— */

/**
 * Neighbors of one memory, found through shared saved things. Every
 * suggestion names the entities it shares — the reason is the feature.
 * Deterministic, bounded, no AI, no recommendation engine.
 */
export async function getSimilarMemories(
  userId: string,
  memoryId: string,
  limit = 6
): Promise<SimilarMemory[]> {
  const entityIds = await listEntityIdsForMemory(userId, memoryId);
  if (entityIds.length === 0) return [];

  const perEntity = await listRecentMemoryIdsForEntities(userId, entityIds, SIMILAR_PER_ENTITY);

  const score = new Map<string, number>();
  const sharedBy = new Map<string, string[]>();
  for (const [entityId, memoryIds] of perEntity) {
    for (const candidateId of memoryIds) {
      if (candidateId === memoryId) continue;
      score.set(candidateId, (score.get(candidateId) ?? 0) + 1);
      const shared = sharedBy.get(candidateId) ?? [];
      shared.push(entityId);
      sharedBy.set(candidateId, shared);
    }
  }
  if (score.size === 0) return [];

  const rows = await getMemoriesByIds(userId, [...score.keys()]);
  const active = rows.filter((memory) => memory.status === "active");
  active.sort(
    (a, b) =>
      (score.get(b.id) ?? 0) - (score.get(a.id) ?? 0) ||
      b.createdAt.getTime() - a.createdAt.getTime()
  );

  const top = active.slice(0, Math.max(1, limit));
  const sharedIds = [...new Set(top.flatMap((memory) => sharedBy.get(memory.id) ?? []))];
  const sharedEntities = await findEntitiesByIds(userId, sharedIds);
  const entityById = new Map(sharedEntities.map((entity) => [entity.id, entity]));

  return top.map((memory) => ({
    memoryId: memory.id,
    title: memory.title,
    snippet: snippet(memory.originalContent),
    memoryType: memory.memoryType,
    createdAt: memory.createdAt,
    shared: (sharedBy.get(memory.id) ?? [])
      .map((id) => entityById.get(id))
      .filter((entity): entity is Entity => Boolean(entity))
      .map((entity) => ({ id: entity.id, name: entity.name })),
  }));
}

/* ————————————————— Discovery ————————————————— */

/**
 * The quiet discovery strip: the people and topics the user's
 * memories already mention, with plain counts. Descriptive only —
 * counts say what is there, nothing judges what it means. Bounded to
 * a pool of the user's entities; a personal archive fits comfortably.
 */
export async function getDiscovery(userId: string): Promise<DiscoveryData> {
  const [peoplePage, topicsPage] = await Promise.all([
    listEntitiesByTypes(userId, ["person"], { page: 1, pageSize: DISCOVERY_POOL }),
    listEntitiesByTypes(userId, TOPIC_ENTITY_TYPES, { page: 1, pageSize: DISCOVERY_POOL }),
  ]);

  const allIds = [...peoplePage.entities, ...topicsPage.entities].map((entity) => entity.id);
  const counts = await countActiveMemoriesForEntities(userId, allIds);

  const build = (entities: Entity[]) =>
    entities
      .map((entity) => ({
        id: entity.id,
        name: entity.name,
        memoryCount: counts.get(entity.id) ?? 0,
      }))
      .filter((entry) => entry.memoryCount > 0)
      .sort((a, b) => b.memoryCount - a.memoryCount || a.name.localeCompare(b.name))
      .slice(0, DISCOVERY_TAKE);

  return {
    people: build(peoplePage.entities),
    topics: build(topicsPage.entities),
  };
}
