/**
 * Source repository — the only place Prisma meets rich-input sources
 * inside the ingestion module. Reads and extraction-state updates;
 * creation happens through the memory module's atomic
 * createMemoryWithSources (provenance must never exist without its
 * memory, except the deliberate unlinked-failure case handled by the
 * retry service, which also goes through that atomic path).
 *
 * Every function takes an explicit userId: ownership is structural.
 * Raw storage keys never leave this layer as paths — they are opaque
 * strings the storage seam understands.
 */

import { db } from "@/lib/db";
import type { Source, SourceView, SourceType, ExtractionStatus } from "@/types/source";
import type { Prisma } from "@prisma/client";

function toSource(row: Prisma.SourceGetPayload<object>): Source {
  let metadata: Record<string, unknown> | null = null;
  if (row.metadata) {
    try {
      const parsed: unknown = JSON.parse(row.metadata);
      metadata = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
    } catch {
      metadata = null;
    }
  }
  return {
    id: row.id,
    userId: row.userId,
    sourceType: row.sourceType as SourceType,
    rawContent: row.rawContent,
    referenceId: row.referenceId,
    metadata,
    extractionStatus: row.extractionStatus as ExtractionStatus,
    extractionError: row.extractionError,
    storageKey: row.storageKey,
    dedupKey: row.dedupKey,
    createdAt: row.createdAt,
  };
}

/** One owned source, or null (foreign ids look exactly like missing ones). */
export async function findSource(userId: string, sourceId: string): Promise<Source | null> {
  if (!sourceId || sourceId.length > 64) return null;
  const row = await db.source.findFirst({ where: { id: sourceId, userId } });
  return row ? toSource(row) : null;
}

/** The source a stable client request id already produced, if any. */
export async function findSourceByDedupKey(userId: string, dedupKey: string): Promise<Source | null> {
  const row = await db.source.findFirst({ where: { userId, dedupKey }, orderBy: { createdAt: "asc" } });
  return row ? toSource(row) : null;
}

/** All sources of one owned memory, oldest first — the provenance view. */
export async function listMemorySources(userId: string, memoryId: string): Promise<Source[]> {
  const memory = await db.memory.findFirst({ where: { id: memoryId, userId }, select: { id: true } });
  if (!memory) return [];
  const joined = await db.memorySource.findMany({
    where: { memoryId: memory.id },
    include: { source: true },
    orderBy: { source: { createdAt: "asc" } },
  });
  const rows = joined.map((link) => link.source);
  // Legacy rows that predate the join table.
  const legacy = await db.source.findMany({
    where: { userId, referenceId: memoryId, id: { notIn: rows.map((row) => row.id) } },
    orderBy: { createdAt: "asc" },
  });
  return [...rows, ...legacy].map(toSource);
}

/** Whether any memory still references this source (retry/deletion support). */
export async function countMemoryLinks(sourceId: string, excludeMemoryId?: string): Promise<number> {
  return db.memorySource.count({
    where: { sourceId, ...(excludeMemoryId ? { memoryId: { not: excludeMemoryId } } : {}) },
  });
}

/** The memory a source currently backs, when exactly one does. */
export async function findLinkedMemoryId(userId: string, sourceId: string): Promise<string | null> {
  const link = await db.memorySource.findFirst({
    where: { sourceId, memory: { userId } },
    select: { memoryId: true },
  });
  if (link) return link.memoryId;
  // Legacy association.
  const source = await db.source.findFirst({ where: { id: sourceId, userId }, select: { referenceId: true } });
  return source?.referenceId ?? null;
}

export interface SourceExtractionPatch {
  rawContent?: string;
  extractionStatus?: ExtractionStatus;
  extractionError?: string | null;
  metadata?: Record<string, unknown>;
  storageKey?: string | null;
}

/** Apply an extraction result to an existing source (the retry path). */
export async function updateSourceExtraction(
  userId: string,
  sourceId: string,
  patch: SourceExtractionPatch
): Promise<Source> {
  const row = await db.source.update({
    where: { id: sourceId, userId },
    data: {
      ...(patch.rawContent !== undefined ? { rawContent: patch.rawContent } : {}),
      ...(patch.extractionStatus !== undefined ? { extractionStatus: patch.extractionStatus } : {}),
      ...(patch.extractionError !== undefined ? { extractionError: patch.extractionError } : {}),
      ...(patch.metadata !== undefined ? { metadata: JSON.stringify(patch.metadata) } : {}),
      ...(patch.storageKey !== undefined ? { storageKey: patch.storageKey } : {}),
    },
  });
  return toSource(row);
}

/**
 * Atomically claim a source for (re)extraction: the update lands only
 * when nothing is already working on it. Returns the claimed source,
 * or null when a run holds it.
 */
export async function claimSourceForExtraction(userId: string, sourceId: string): Promise<Source | null> {
  const count = await db.source.updateMany({
    where: { id: sourceId, userId, extractionStatus: { not: "processing" } },
    data: { extractionStatus: "processing", extractionError: null },
  });
  if (count.count !== 1) return null;
  const row = await db.source.findFirst({ where: { id: sourceId, userId } });
  return row ? toSource(row) : null;
}

/** Project a source for the UI — no storage keys, no internals. */
export function toSourceView(source: Source): SourceView {
  const metadata = source.metadata ?? {};
  return {
    id: source.id,
    sourceType: source.sourceType,
    extractionStatus: source.extractionStatus,
    extractionError: source.extractionError,
    content: source.rawContent !== "" ? source.rawContent : null,
    label:
      typeof metadata.originalFilename === "string" && metadata.originalFilename !== ""
        ? metadata.originalFilename
        : typeof metadata.pageTitle === "string" && metadata.pageTitle !== ""
          ? metadata.pageTitle
          : source.sourceType === "url"
            ? ((typeof metadata.url === "string" ? metadata.url : source.rawContent) || null)
            : null,
    mimeType: typeof metadata.mimeType === "string" && metadata.mimeType !== "" ? metadata.mimeType : null,
    sizeBytes:
      typeof metadata.sizeBytes === "number"
        ? metadata.sizeBytes
        : typeof metadata.size === "number"
          ? (metadata.size as number)
          : null,
    hasOriginal: Boolean(source.storageKey),
    hasThumbnail: typeof metadata.thumbnailKey === "string" && metadata.thumbnailKey !== "",
    url: typeof metadata.url === "string" && metadata.url !== "" ? metadata.url : null,
    createdAt: source.createdAt.toISOString(),
  };
}
