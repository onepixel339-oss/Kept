/**
 * Memory repository — the only place Prisma meets memories.
 *
 * Every function takes an explicit userId and scopes its query by it:
 * ownership is enforced by construction, not by convention. The
 * service layer never writes Prisma; this layer never decides policy.
 */

import { db } from "@/lib/db";
import type {
  Memory,
  MemoryStatus,
  MemoryType,
} from "@/types/memory";
import type { MemoryVersion, VersionChangeType } from "@/types/memory-version";
import type {
  EmbeddingStatus,
  ProcessingStatus,
} from "@/types/processing";
import type { ExtractionStatus, SourceType } from "@/types/source";
import type { Prisma } from "@prisma/client";

/** Internal creation payload — already validated by the service. */
export interface CreateMemoryData {
  title: string | null;
  originalContent: string;
  memoryType: MemoryType;
  importance: number;
  rememberedAt: Date | null;
}

/**
 * A provenance seed (Phase 9): plain data for one source row, decided
 * upstream (the ingestion module parsed modalities; this module only
 * stores provenance). `rawContent` is the captured text — typed words,
 * a transcript, or extracted text.
 */
export interface SourceSeed {
  sourceType: SourceType;
  rawContent: string;
  metadata?: Record<string, unknown> | null;
  storageKey?: string | null;
  extractionStatus?: ExtractionStatus;
  extractionError?: string | null;
  dedupKey?: string | null;
}

export interface UpdateMemoryData {
  title?: string | null;
  summary?: string | null;
  originalContent?: string;
  memoryType?: MemoryType;
  importance?: number;
  rememberedAt?: Date | null;
  status?: MemoryStatus;
}

export interface ListMemoryFilters {
  q?: string;
  status?: MemoryStatus;
  memoryType?: MemoryType;
  page: number;
  pageSize: number;
}

function toMemory(row: Prisma.MemoryGetPayload<object>): Memory {
  return {
    id: row.id,
    userId: row.userId,
    title: row.title,
    originalContent: row.originalContent,
    summary: row.summary,
    memoryType: row.memoryType as MemoryType,
    importance: row.importance,
    confidence: row.confidence,
    status: row.status as MemoryStatus,
    rememberedAt: row.rememberedAt,
    processingStatus: row.processingStatus as ProcessingStatus,
    processingError: row.processingError,
    processedAt: row.processedAt,
    embeddingStatus: row.embeddingStatus as EmbeddingStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Create a memory with its creation version (v1) and provenance
 * sources, atomically (Phase 9 generalization).
 *
 * Every seed becomes a `sources` row linked through `memory_sources`
 * (the many-to-many provenance join) with `referenceId` kept in sync
 * for compatibility. `attachSourceIds` links EXISTING user-owned
 * sources (the retry path) instead of creating new ones.
 *
 * With no seeds, the memory gets the classic single user_input source
 * — the pre-Phase-9 behavior, byte-for-byte.
 */
export async function createMemoryWithSources(
  userId: string,
  data: CreateMemoryData,
  sources: SourceSeed[] = [],
  options: { attachSourceIds?: string[] } = {}
): Promise<Memory> {
  const memory = await db.$transaction(async (tx) => {
    const created = await tx.memory.create({
      data: {
        userId,
        title: data.title,
        originalContent: data.originalContent,
        memoryType: data.memoryType,
        importance: data.importance,
        rememberedAt: data.rememberedAt,
      },
    });

    await tx.memoryVersion.create({
      data: {
        memoryId: created.id,
        versionNumber: 1,
        originalContent: created.originalContent,
        title: created.title,
        summary: created.summary,
        changeType: "created",
      },
    });

    const linkSource = async (sourceId: string): Promise<void> => {
      await tx.memorySource.upsert({
        where: { memoryId_sourceId: { memoryId: created.id, sourceId } },
        create: { memoryId: created.id, sourceId },
        update: {},
      });
    };

    const seeds: SourceSeed[] =
      sources.length > 0
        ? sources
        : [{ sourceType: "user_input", rawContent: data.originalContent }];

    for (const seed of seeds) {
      const source = await tx.source.create({
        data: {
          userId,
          sourceType: seed.sourceType,
          rawContent: seed.rawContent,
          referenceId: created.id,
          metadata: seed.metadata ? JSON.stringify(seed.metadata) : null,
          storageKey: seed.storageKey ?? null,
          extractionStatus: seed.extractionStatus ?? "ready",
          extractionError: seed.extractionError ?? null,
          dedupKey: seed.dedupKey ?? null,
        },
      });
      await linkSource(source.id);
    }

    for (const sourceId of options.attachSourceIds ?? []) {
      const existing = await tx.source.findFirst({ where: { id: sourceId, userId } });
      if (!existing) continue; // foreign/unknown ids never link
      await linkSource(existing.id);
      if (!existing.referenceId) {
        await tx.source.update({ where: { id: existing.id }, data: { referenceId: created.id } });
      }
    }

    return created;
  });

  return toMemory(memory);
}

/** Find one memory owned by the user, or null. */
export async function findMemory(userId: string, memoryId: string): Promise<Memory | null> {
  const row = await db.memory.findFirst({
    where: { id: memoryId, userId },
  });
  return row ? toMemory(row) : null;
}

/** List memories owned by the user, newest first, with simple filters. */
export async function listMemories(
  userId: string,
  filters: ListMemoryFilters
): Promise<{ rows: Memory[]; total: number }> {
  const where: Prisma.MemoryWhereInput = {
    userId,
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.memoryType ? { memoryType: filters.memoryType } : {}),
    ...(filters.q
      ? {
          OR: [
            { title: { contains: filters.q } },
            { summary: { contains: filters.q } },
            { originalContent: { contains: filters.q } },
          ],
        }
      : {}),
  };

  const [rows, total] = await db.$transaction([
    db.memory.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (filters.page - 1) * filters.pageSize,
      take: filters.pageSize,
    }),
    db.memory.count({ where }),
  ]);

  return { rows: rows.map(toMemory), total };
}

/** Append the next version to a memory's history. */
export async function appendVersion(
  memoryId: string,
  data: {
    versionNumber: number;
    originalContent: string;
    title: string | null;
    summary: string | null;
    changeType: VersionChangeType;
    changeReason?: string | null;
  }
): Promise<MemoryVersion> {
  const row = await db.memoryVersion.create({ data: { memoryId, ...data } });
  return {
    id: row.id,
    memoryId: row.memoryId,
    versionNumber: row.versionNumber,
    originalContent: row.originalContent,
    title: row.title,
    summary: row.summary,
    changeType: row.changeType as VersionChangeType,
    changeReason: row.changeReason,
    createdAt: row.createdAt,
  };
}

/** Highest version number written so far for a memory (0 when none). */
export async function latestVersionNumber(memoryId: string): Promise<number> {
  const row = await db.memoryVersion.findFirst({
    where: { memoryId },
    orderBy: { versionNumber: "desc" },
    select: { versionNumber: true },
  });
  return row?.versionNumber ?? 0;
}

/* ————————————————— Intelligence processing state (Phase 3) ————————————————— */

/**
 * Atomically claim a memory for processing. The update only lands when
 * the memory is NOT already being processed, so concurrent triggers
 * (a retry plus a stale background run) cannot double-run a pipeline.
 * Returns the claimed memory, or null when another run holds it.
 */
export async function claimForProcessing(memoryId: string): Promise<Memory | null> {
  const count = await db.memory.updateMany({
    where: { id: memoryId, processingStatus: { not: "processing" } },
    data: {
      processingStatus: "processing",
      processingError: null,
    },
  });
  if (count.count !== 1) return null;
  const row = await db.memory.findUnique({ where: { id: memoryId } });
  return row ? toMemory(row) : null;
}

export async function markProcessingFailed(
  memoryId: string,
  reason: string
): Promise<void> {
  await db.memory.updateMany({
    where: { id: memoryId },
    data: { processingStatus: "failed", processingError: reason },
  });
}

export async function markProcessingReady(memoryId: string): Promise<void> {
  await db.memory.updateMany({
    where: { id: memoryId },
    data: {
      processingStatus: "ready",
      processingError: null,
      processedAt: new Date(),
    },
  });
}

export interface EnrichmentPatch {
  title?: string | null;
  summary?: string | null;
  memoryType?: MemoryType;
  confidence?: number;
  rememberedAt?: Date | null;
  embeddingStatus?: EmbeddingStatus;
}

/**
 * Apply AI-derived enrichment in place. This is understanding, not a
 * user edit: it deliberately does NOT create versions. AI fields are
 * replaceable and recomputable; version history belongs to the user's
 * own meaningful changes. The original content is never touched here.
 */
export async function applyEnrichment(
  userId: string,
  memoryId: string,
  patch: EnrichmentPatch
): Promise<Memory> {
  const row = await db.memory.update({
    where: { id: memoryId, userId },
    data: patch,
  });
  return toMemory(row);
}

export interface StateUpdateData {
  originalContent: string;
  title: string | null;
  summary: string | null;
}

/**
 * Apply a state update to a memory: the memory's current row becomes
 * the NEW state and the previous state is appended as a version with a
 * change reason. Used by the decision engine when a newer memory
 * clearly supersedes an older one — history is never overwritten, the
 * superseded state stays retrievable in the version list.
 */
export async function applyStateUpdate(
  userId: string,
  memoryId: string,
  data: StateUpdateData,
  changeReason: string
): Promise<Memory> {
  return db.$transaction(async (tx) => {
    const current = await tx.memory.findFirst({ where: { id: memoryId, userId } });
    if (!current) {
      throw new Error("State update target disappeared mid-transaction.");
    }

    const latest = await tx.memoryVersion.findFirst({
      where: { memoryId },
      orderBy: { versionNumber: "desc" },
      select: { versionNumber: true },
    });

    await tx.memoryVersion.create({
      data: {
        memoryId,
        versionNumber: (latest?.versionNumber ?? 0) + 1,
        originalContent: data.originalContent,
        title: data.title,
        summary: data.summary,
        changeType: "edited",
        changeReason,
      },
    });

    const row = await tx.memory.update({
      where: { id: memoryId },
      data: {
        originalContent: data.originalContent,
        title: data.title,
        summary: data.summary,
      },
    });
    return toMemory(row);
  });
}

/**
 * Apply a partial update in place. Textual versioning is decided by
 * the service; this is the plain write.
 */
export async function updateMemory(
  userId: string,
  memoryId: string,
  data: UpdateMemoryData
): Promise<Memory> {
  const row = await db.memory.update({
    where: { id: memoryId, userId },
    data,
  });
  return toMemory(row);
}

/**
 * Delete a memory and everything that hangs off it, atomically:
 * versions, memory↔entity links, relations touching it (either
 * direction), and its provenance sources — the Phase 9 safety rules
 * (spec §28):
 *   - a source referenced ONLY by this memory is deleted with it;
 *   - a source shared by other memories (via memory_sources, or a
 *     legacy referenceId pointing elsewhere) survives untouched;
 *   - the storage keys of anything deleted are returned so the caller
 *     can remove the preserved originals AFTER the transaction — no
 *     orphaned files, and no file removed while its row still exists.
 * Entities are NOT deleted — they are reusable and may be linked from
 * other memories.
 */
export async function deleteMemoryWithGraph(
  userId: string,
  memoryId: string
): Promise<{ storageKeys: string[] }> {
  return db.$transaction(async (tx) => {
    // Ownership gate inside the transaction — delete nothing otherwise.
    const memory = await tx.memory.findFirst({ where: { id: memoryId, userId } });
    if (!memory) return { storageKeys: [] };

    await tx.relation.deleteMany({
      where: {
        userId,
        OR: [
          { sourceType: "memory", sourceId: memoryId },
          { targetType: "memory", targetId: memoryId },
        ],
      },
    });

    // Sources joined through memory_sources, plus legacy rows that only
    // carry referenceId (pre-Phase-9 data). Deduplicated by id.
    const joined = await tx.memorySource.findMany({
      where: { memoryId },
      include: { source: true },
    });
    const legacy = await tx.source.findMany({
      where: { userId, referenceId: memoryId },
    });

    const candidates = new Map<string, { id: string; storageKey: string | null; metadata: string | null }>();
    for (const row of joined) {
      if (row.source.userId === userId) {
        candidates.set(row.source.id, {
          id: row.source.id,
          storageKey: row.source.storageKey,
          metadata: row.source.metadata,
        });
      }
    }
    for (const row of legacy) {
      if (!candidates.has(row.id)) {
        candidates.set(row.id, { id: row.id, storageKey: row.storageKey, metadata: row.metadata });
      }
    }

    const storageKeys: string[] = [];
    for (const candidate of candidates.values()) {
      // Any OTHER memory still referencing this source keeps it alive.
      // Join rows always point at existing memories (FK cascade), but a
      // legacy referenceId may point at an already-deleted memory —
      // only a reference to a memory that STILL EXISTS counts.
      const otherJoins = await tx.memorySource.count({
        where: { sourceId: candidate.id, memoryId: { not: memoryId } },
      });
      let legacyElsewhere = 0;
      if (otherJoins === 0) {
        const row = await tx.source.findUnique({
          where: { id: candidate.id },
          select: { referenceId: true },
        });
        if (row?.referenceId && row.referenceId !== memoryId) {
          legacyElsewhere = await tx.memory.count({
            where: { id: row.referenceId, userId },
          });
        }
      }
      if (otherJoins === 0 && legacyElsewhere === 0) {
        if (candidate.storageKey) storageKeys.push(candidate.storageKey);
        if (candidate.metadata) {
          try {
            const parsed = JSON.parse(candidate.metadata) as { thumbnailKey?: unknown };
            if (typeof parsed.thumbnailKey === "string" && parsed.thumbnailKey !== "") {
              storageKeys.push(parsed.thumbnailKey);
            }
          } catch {
            // Malformed metadata never blocks deletion.
          }
        }
        await tx.source.delete({ where: { id: candidate.id } });
      }
    }

    await tx.memorySource.deleteMany({ where: { memoryId } });

    // Versions and memory_entities cascade via foreign keys; they are
    // deleted explicitly anyway so the behavior reads identically on
    // PostgreSQL and SQLite.
    await tx.memoryVersion.deleteMany({ where: { memoryId } });
    await tx.memoryEntity.deleteMany({ where: { memoryId } });

    await tx.memory.delete({ where: { id: memoryId } });

    return { storageKeys };
  });
}

/* ————————————————— Retrieval support (Phase 4) ————————————————— */

/**
 * Fetch full memory rows by id, ownership-scoped, returned in the
 * caller's id order. Unknown/foreign ids are silently absent — the
 * query module treats absence as "not a candidate".
 */
export async function listMemoriesByIds(userId: string, memoryIds: string[]): Promise<Memory[]> {
  if (memoryIds.length === 0) return [];
  const rows = await db.memory.findMany({
    where: { userId, id: { in: memoryIds } },
  });
  const byId = new Map(rows.map((row) => [row.id, toMemory(row)]));
  return memoryIds.flatMap((id) => {
    const memory = byId.get(id);
    return memory ? [memory] : [];
  });
}

/**
 * Memories inside a time window: `rememberedAt` when known, otherwise
 * the kept-date as a proxy — a memory without an event date can still
 * belong to a month the user asks about. Bounded, ownership-scoped.
 */
export async function listMemoriesInWindow(
  userId: string,
  window: { from: Date; to: Date },
  options: { limit?: number; memoryTypes?: MemoryType[] } = {}
): Promise<Memory[]> {
  const rows = await db.memory.findMany({
    where: {
      userId,
      ...(options.memoryTypes?.length ? { memoryType: { in: options.memoryTypes } } : {}),
      OR: [
        { rememberedAt: { gte: window.from, lte: window.to } },
        { rememberedAt: null, createdAt: { gte: window.from, lte: window.to } },
      ],
    },
    orderBy: { rememberedAt: "asc" },
    take: options.limit ?? 50,
  });
  return rows.map(toMemory);
}

/* ————————————————— Exploration support (Phase 6) ————————————————— */

/**
 * Memories with a KNOWN event date (`rememberedAt`), one bounded page
 * plus the total — the timeline's rows. Unlike `listMemoriesInWindow`
 * (retrieval semantics, which may substitute the kept-date proxy),
 * this never invents a date: memories without `rememberedAt` are
 * simply absent, and `countUndatedMemories` reports them honestly.
 *
 * The optional entity filter reads only through the memory_entities
 * join (the same symmetric pattern the entity repository uses when it
 * scopes links by `memory: { userId }`) — this layer interprets no
 * entity data. Statuses default to active-only, matching the
 * visibility rules retrieval established.
 */
export async function listDatedMemories(
  userId: string,
  options: {
    from?: Date;
    to?: Date;
    entityIds?: string[];
    memoryTypes?: MemoryType[];
    statuses?: MemoryStatus[];
    order?: "asc" | "desc";
    page: number;
    pageSize: number;
  }
): Promise<{ memories: Memory[]; total: number }> {
  const rememberedAt: Prisma.DateTimeNullableFilter = { not: null };
  if (options.from) rememberedAt.gte = options.from;
  if (options.to) rememberedAt.lte = options.to;

  const where: Prisma.MemoryWhereInput = {
    userId,
    rememberedAt,
    status: { in: options.statuses?.length ? options.statuses : ["active"] },
    ...(options.memoryTypes?.length ? { memoryType: { in: options.memoryTypes } } : {}),
    ...(options.entityIds?.length
      ? {
          memoryEntities: {
            some: {
              entityId: { in: options.entityIds },
              entity: { userId },
            },
          },
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    db.memory.findMany({
      where,
      orderBy: { rememberedAt: options.order ?? "desc" },
      skip: (options.page - 1) * options.pageSize,
      take: options.pageSize,
    }),
    db.memory.count({ where }),
  ]);
  return { memories: rows.map(toMemory), total };
}

/**
 * How many ACTIVE memories carry no known event date. The timeline
 * shows this count as an honest note instead of fabricating dates.
 */
export async function countUndatedMemories(userId: string): Promise<number> {
  return db.memory.count({
    where: { userId, rememberedAt: null, status: "active" },
  });
}

/** A memory's version history, oldest first. Empty when not owned. */
export async function listVersions(userId: string, memoryId: string): Promise<MemoryVersion[]> {
  const rows = await db.memoryVersion.findMany({
    where: { memory: { id: memoryId, userId } },
    orderBy: { versionNumber: "asc" },
  });
  return rows.map((row) => ({
    id: row.id,
    memoryId: row.memoryId,
    versionNumber: row.versionNumber,
    originalContent: row.originalContent,
    title: row.title,
    summary: row.summary,
    changeType: row.changeType as VersionChangeType,
    changeReason: row.changeReason,
    createdAt: row.createdAt,
  }));
}

export { toMemory };

/* ————————————————— Embedding lifecycle support (Phase 8) ————————————————— */

/**
 * Memories in the given embedding statuses, oldest-updated first,
 * bounded — the internal reprocessing service's work list (stale after
 * edits, failed attempts, or everything when the model/version
 * changes). Ownership-scoped like every read here.
 */
export async function listMemoriesByEmbeddingStatus(
  userId: string,
  statuses: EmbeddingStatus[],
  limit: number
): Promise<Memory[]> {
  if (statuses.length === 0) return [];
  const rows = await db.memory.findMany({
    where: { userId, embeddingStatus: { in: statuses } },
    orderBy: { updatedAt: "asc" },
    take: Math.max(1, Math.floor(limit)),
  });
  return rows.map(toMemory);
}
