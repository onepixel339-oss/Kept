/**
 * Memory application services — the module's public use cases.
 *
 * Responsibilities:
 *  - Validate input (zod) before anything touches the database
 *  - Enforce domain rules (meaningful-change versioning, deterministic
 *    titles, verbatim original content)
 *  - Orchestrate the repository; never leak Prisma upward
 *  - Throw AppError with stable codes; never leak database details
 *
 * Every function takes an explicit userId. There is no code path that
 * reads or writes a memory without one — ownership is structural.
 *
 * Phase 3 adds the processing-state surface the intelligence pipeline
 * uses (claim, enrich, state updates, failure marks). The pipeline —
 * NOT the AI — is the caller: AI proposals arrive here already
 * validated by the intelligence module's domain logic.
 */

import { AppError } from "@/lib/api";
import { snippet } from "@/lib/format";
import { getAiGateway } from "@/lib/ai";
import { getStorage } from "@/lib/storage";
import type {
  Memory,
  MemoryListItem,
  MemoryListResult,
  MemoryType,
} from "@/types/memory";
import type { MemoryVersion } from "@/types/memory-version";
import type {
  EmbeddingStatus,
  ProcessingStatus,
} from "@/types/processing";
import {
  createMemorySchema,
  listMemoriesQuerySchema,
  memoryIdSchema,
  updateMemorySchema,
  type ListMemoriesQuery,
} from "./validation";
import {
  deriveTitle,
  isMeaningfulChange,
  MEMORY_TYPE_VALUES,
} from "../domain/memory-rules";
import * as repo from "../infrastructure/memory-repository";

function assertMemoryId(memoryId: string): void {
  const parsed = memoryIdSchema.safeParse(memoryId);
  if (!parsed.success) {
    throw new AppError("not_found", "That memory could not be found.");
  }
}

function requireMemory(memory: Memory | null): Memory {
  if (!memory) {
    // "Not found" rather than "forbidden" — one user's ids are not
    // another user's information.
    throw new AppError("not_found", "That memory could not be found.");
  }
  return memory;
}

/**
 * Create a memory: derive a deterministic title when none is given,
 * write v1 of the version history, and record the user_input source —
 * atomically.
 */
export async function createMemory(
  userId: string,
  input: unknown
): Promise<Memory> {
  const data = createMemorySchema.parse(input);
  const title =
    data.title !== undefined && data.title !== null && data.title !== ""
      ? data.title
      : deriveTitle(data.originalContent) || null;

  return repo.createMemoryWithSources(userId, {
    title,
    originalContent: data.originalContent,
    memoryType: data.memoryType,
    importance: data.importance ?? 0.5,
    rememberedAt: data.rememberedAt ?? null,
  });
}

/* ————————————————— Ingestion support (Phase 9) ————————————————— */

/**
 * Create a memory with rich provenance sources (Phase 9). The seeds
 * are plain data — the ingestion module parsed every modality BEFORE
 * calling this; the memory module never learns how files, images,
 * audio, or URLs were read (spec §1). Ownership and non-emptiness are
 * enforced here; everything else is trust-the-caller-by-design (the
 * ingestion module is the only caller).
 */
export async function createMemoryWithSources(
  userId: string,
  data: {
    originalContent: string;
    title?: string | null;
    rememberedAt?: Date | null;
  },
  sources: repo.SourceSeed[],
  options: { attachSourceIds?: string[] } = {}
): Promise<Memory> {
  const content = data.originalContent.trim();
  if (content === "") {
    throw new AppError("validation_failed", "A memory needs words — the content cannot be empty.");
  }
  if (content.length > 400_000) {
    throw new AppError("validation_failed", "That memory is too long to keep in one piece.");
  }
  const title =
    data.title !== undefined && data.title !== null && data.title !== ""
      ? data.title
      : deriveTitle(content) || null;

  return repo.createMemoryWithSources(
    userId,
    {
      title,
      originalContent: content,
      memoryType: "note",
      importance: 0.5,
      rememberedAt: data.rememberedAt ?? null,
    },
    sources,
    options
  );
}

/** Read one memory. Cross-user reads look exactly like missing ones. */
export async function getMemory(userId: string, memoryId: string): Promise<Memory> {
  assertMemoryId(memoryId);
  return requireMemory(await repo.findMemory(userId, memoryId));
}

/** Null-safe read, for sibling modules that need existence checks. */
export async function findMemory(userId: string, memoryId: string): Promise<Memory | null> {
  const parsed = memoryIdSchema.safeParse(memoryId);
  if (!parsed.success) return null;
  return repo.findMemory(userId, memoryId);
}

/** List the user's memories, newest first, with optional search/filters. */
export async function listMemories(
  userId: string,
  query: Partial<ListMemoriesQuery> = {}
): Promise<MemoryListResult> {
  const filters = listMemoriesQuerySchema.parse(query);
  const { rows, total } = await repo.listMemories(userId, filters);

  const items: MemoryListItem[] = rows.map((memory) => ({
    id: memory.id,
    title: memory.title,
    snippet: snippet(memory.originalContent),
    memoryType: memory.memoryType,
    status: memory.status,
    processingStatus: memory.processingStatus,
    rememberedAt: memory.rememberedAt,
    createdAt: memory.createdAt,
  }));

  return { items, page: filters.page, pageSize: filters.pageSize, total };
}

/**
 * Update a memory. Textual changes (originalContent, title, summary)
 * append a version capturing the NEW state; metadata changes update
 * in place. History is never overwritten.
 *
 * Phase 8 (embedding lifecycle, spec §22): when the text changes, any
 * stored embedding is invalidated — the old vector must never
 * represent the new content. The memory's embedding status moves to
 * `pending` (regenerable via the internal reprocessing service) and
 * the vector rows drop out of every search immediately. Invalidation
 * trouble never fails the user's edit — the memory stays fully
 * usable, and the worst case (a not-yet-invalidated row) is repaired
 * by reprocessing.
 */
export async function updateMemory(
  userId: string,
  memoryId: string,
  input: unknown
): Promise<Memory> {
  assertMemoryId(memoryId);
  const data = updateMemorySchema.parse(input);
  const existing = requireMemory(await repo.findMemory(userId, memoryId));

  const after = {
    originalContent: data.originalContent ?? existing.originalContent,
    title: data.title !== undefined ? data.title : existing.title,
    summary: data.summary !== undefined ? data.summary : existing.summary,
  };

  const textChanged = isMeaningfulChange(existing, after);

  if (textChanged) {
    const versionNumber = (await repo.latestVersionNumber(memoryId)) + 1;
    await repo.appendVersion(memoryId, {
      versionNumber,
      originalContent: after.originalContent,
      title: after.title,
      summary: after.summary,
      changeType: "edited",
    });
  }

  const { originalContent, title, summary, ...metadata } = data;
  const update: repo.UpdateMemoryData = {
    ...metadata,
    ...(originalContent !== undefined ? { originalContent } : {}),
    ...(title !== undefined ? { title: title === "" ? null : title } : {}),
    ...(summary !== undefined ? { summary: summary === "" ? null : summary } : {}),
  };

  const updated = await repo.updateMemory(userId, memoryId, update);

  if (textChanged && existing.embeddingStatus === "ready") {
    try {
      // Storage seam (not an AI call): the vector's lifecycle is bound
      // to the memory's text, so the memory module drives invalidation.
      await getAiGateway().embeddings().invalidate(memoryId);
      await applyMemoryEnrichment(userId, memoryId, { embeddingStatus: "pending" });
    } catch (error) {
      console.error("[embeddings] invalidation after edit failed:", error);
    }
  }

  return updated;
}

/**
 * Delete a memory: versions, entity links, relations touching it, and
 * sources are removed atomically — with the Phase 9 sharing rule: a
 * source other memories still reference survives (spec §28). The
 * preserved originals behind deleted sources are removed from the
 * storage seam afterwards; a storage failure never blocks the delete
 * (the row is gone; the file is swept by the same best-effort pass —
 * an orphan is logged, never hidden).
 * Entities survive — they may be linked from memories that remain.
 * Deleting is a real decision, not a status flag.
 *
 * Phase 8 (spec §21): the memory's embedding dies with it — the FK
 * cascade removes the vector rows, and the explicit repository delete
 * below is defense-in-depth for stores without cascades. After this
 * returns, no semantic search can surface the deleted memory.
 */
export async function deleteMemory(userId: string, memoryId: string): Promise<void> {
  assertMemoryId(memoryId);
  requireMemory(await repo.findMemory(userId, memoryId));
  const { storageKeys } = await repo.deleteMemoryWithGraph(userId, memoryId);
  try {
    await getAiGateway().embeddings().delete(memoryId);
  } catch (error) {
    console.error("[embeddings] delete after memory removal failed:", error);
  }
  const storage = getStorage();
  for (const key of storageKeys) {
    try {
      await storage.delete(key);
    } catch (error) {
      console.error("[storage] orphaned object after memory delete:", key, error);
    }
  }
}

/** A memory's version history, oldest first. Ownership enforced. */
export async function getMemoryVersions(
  userId: string,
  memoryId: string
): Promise<MemoryVersion[]> {
  assertMemoryId(memoryId);
  requireMemory(await repo.findMemory(userId, memoryId));
  return repo.listVersions(userId, memoryId);
}

/* ————————————————— Intelligence processing surface (Phase 3) ————————————————— */

/**
 * Claim a memory for processing, atomically. Returns the claimed
 * memory, or null when another run is already processing it. The
 * pipeline (which has already verified ownership) is the caller.
 */
export async function claimMemoryForProcessing(memoryId: string): Promise<Memory | null> {
  return repo.claimForProcessing(memoryId);
}

/** Mark processing as failed with a stable, human-safe reason. */
export async function markMemoryProcessingFailed(
  userId: string,
  memoryId: string,
  reason: string
): Promise<void> {
  const memory = await repo.findMemory(userId, memoryId);
  if (!memory) return; // deleted mid-flight — nothing to mark
  await repo.markProcessingFailed(memoryId, reason);
}

/** Mark processing as complete. */
export async function markMemoryProcessingReady(userId: string, memoryId: string): Promise<void> {
  const memory = await repo.findMemory(userId, memoryId);
  if (!memory) return;
  await repo.markProcessingReady(memoryId);
}

export interface AiEnrichment {
  title?: string | null;
  summary?: string | null;
  memoryType?: MemoryType;
  confidence?: number;
  rememberedAt?: Date | null;
  embeddingStatus?: EmbeddingStatus;
}

/**
 * Apply AI-derived enrichment to a memory, in place, without creating
 * a version. Enrichment is understanding — recomputable, replaceable —
 * while version history records the user's own meaningful edits. The
 * original content cannot be touched through this surface: it is not
 * an accepted field.
 *
 * The intelligence pipeline computes WHAT may be enriched (guard rules
 * live there); this function is the validated write path.
 */
export async function applyMemoryEnrichment(
  userId: string,
  memoryId: string,
  enrichment: AiEnrichment
): Promise<Memory> {
  const memory = requireMemory(await repo.findMemory(userId, memoryId));

  const patch: repo.EnrichmentPatch = {};
  if (enrichment.title !== undefined) {
    const title = enrichment.title?.trim() ?? "";
    patch.title = title === "" ? null : title.slice(0, 200);
  }
  if (enrichment.summary !== undefined) {
    const summary = enrichment.summary?.trim() ?? "";
    patch.summary = summary === "" ? null : summary.slice(0, 2_000);
  }
  if (enrichment.memoryType !== undefined) {
    if (!MEMORY_TYPE_VALUES.includes(enrichment.memoryType)) {
      throw new AppError("validation_failed", "That memory type is not recognized.");
    }
    patch.memoryType = enrichment.memoryType;
  }
  if (enrichment.confidence !== undefined) {
    patch.confidence = Math.min(1, Math.max(0, enrichment.confidence));
  }
  if (enrichment.rememberedAt !== undefined) {
    patch.rememberedAt = enrichment.rememberedAt;
  }
  if (enrichment.embeddingStatus !== undefined) {
    patch.embeddingStatus = enrichment.embeddingStatus;
  }

  // Enrichment must never alter the user's words or lifecycle status.
  void memory;
  return repo.applyEnrichment(userId, memoryId, patch);
}

/**
 * Replace a memory's current textual state with a newer one (from a
 * newer memory the decision engine judged to supersede it), preserving
 * the previous state as a version with the given reason. The incoming
 * content is the user's own verbatim words — never generated text.
 */
export async function applyMemoryStateUpdate(
  userId: string,
  memoryId: string,
  newState: { originalContent: string; title: string | null; summary: string | null },
  changeReason: string
): Promise<Memory> {
  assertMemoryId(memoryId);
  requireMemory(await repo.findMemory(userId, memoryId));

  if (newState.originalContent.trim() === "") {
    throw new AppError("validation_failed", "A memory needs words — the content cannot be empty.");
  }

  return repo.applyStateUpdate(userId, memoryId, newState, changeReason);
}

/** Whether any processing run currently claims this memory. */
export async function getMemoryProcessingStatus(
  userId: string,
  memoryId: string
): Promise<ProcessingStatus | null> {
  const memory = await repo.findMemory(userId, memoryId);
  return memory?.processingStatus ?? null;
}

/* ————————————————— Retrieval support (Phase 4) ————————————————— */

/**
 * Full memory rows by id, ownership-scoped, in caller order. The query
 * module's retrievers and context builder use this for batched
 * projections — never a cross-module reach into the repository.
 * Foreign/unknown ids are silently absent.
 */
export async function getMemoriesByIds(userId: string, memoryIds: string[]): Promise<Memory[]> {
  const unique = [...new Set(memoryIds)].filter((id) => memoryIdSchema.safeParse(id).success);
  return repo.listMemoriesByIds(userId, unique);
}

/**
 * Memories inside a time window (event date when known, kept-date as
 * an honest proxy otherwise). Bounded and ownership-scoped; the
 * temporal retriever's entire data path.
 */
export async function listMemoriesInWindow(
  userId: string,
  window: { from: Date; to: Date },
  options: { limit?: number; memoryTypes?: MemoryType[] } = {}
): Promise<Memory[]> {
  return repo.listMemoriesInWindow(userId, window, options);
}

/* ————————————————— Exploration support (Phase 6) ————————————————— */

/**
 * One bounded page of memories that carry a KNOWN event date — the
 * timeline's data path. Never substitutes the kept-date: a memory
 * without `rememberedAt` is absent here (and counted honestly by
 * `countUndatedMemories` instead). The optional entity filter narrows
 * to memories linked to those entities; ownership is structural.
 */
export async function listDatedMemories(
  userId: string,
  options: {
    from?: Date;
    to?: Date;
    entityIds?: string[];
    memoryTypes?: MemoryType[];
    order?: "asc" | "desc";
    page: number;
    pageSize: number;
  }
): Promise<{ memories: Memory[]; total: number }> {
  const page = Math.max(1, Math.floor(options.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Math.floor(options.pageSize) || 20));
  return repo.listDatedMemories(userId, { ...options, page, pageSize });
}

/** How many ACTIVE memories carry no known event date (timeline's honest note). */
export async function countUndatedMemories(userId: string): Promise<number> {
  return repo.countUndatedMemories(userId);
}

/* ————————————————— Embedding lifecycle support (Phase 8) ————————————————— */

/**
 * The internal embedding-reprocessing service's work list: memories in
 * the given embedding statuses (pending/failed after edits or provider
 * errors), oldest-updated first, bounded. Ownership-scoped; a read
 * only — reprocessing itself lives in the intelligence module.
 */
export async function listMemoriesByEmbeddingStatus(
  userId: string,
  statuses: EmbeddingStatus[],
  limit: number
): Promise<Memory[]> {
  return repo.listMemoriesByEmbeddingStatus(userId, statuses, limit);
}
