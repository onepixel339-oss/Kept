/**
 * The embedding reprocessing service — Phase 8 §15/§16.
 *
 * A simple internal application service (deliberately NOT an admin
 * dashboard, NOT a REST endpoint, NOT a job queue): regenerate
 * embeddings for one memory, for stale/failed memories, or for
 * everything when the model/version changes. Progressive by design —
 * the rest of the application never blocks on it.
 *
 * Honesty rules (binding):
 *  - When no provider can embed (this environment: the z.ai SDK has
 *    no embedding API), every function returns a truthful report and
 *    touches NOTHING — no fabricated vectors, no fake progress.
 *  - When a provider does embed (deterministic fixtures in tests; a
 *    real provider in the future), the stored vector is exactly what
 *    the provider returned, under its (model, version) identity —
 *    repository upsert makes retries idempotent, never duplicates.
 *  - Every work list is bounded; a run processes at most
 *    `maxEmbeddingReprocessBatch` memories.
 *  - Memory text is never logged (§27).
 */

import { getAiGateway, type AiGateway, type EmbeddingRequest, type MemoryIntelligenceProvider } from "@/lib/ai";
import {
  applyMemoryEnrichment,
  findMemory,
  getMemoriesByIds,
  listMemoriesByEmbeddingStatus,
} from "@/modules/memory";
import { findEntitiesByIds, listEntityIdsForMemory } from "@/modules/entity";
import {
  buildEmbeddingText,
  representationFromMemory,
} from "../domain/embedding-representation";

/** Bound on memories processed per reprocessing run (§15: safe, simple, bounded). */
export const maxEmbeddingReprocessBatch = 200;

export interface ReprocessingReport {
  /** Memories the run genuinely attempted (a capable provider was present). */
  attempted: number;
  /** Memories whose vector was stored/updated successfully. */
  stored: number;
  /** Memories whose embedding attempt errored (retryable; status = failed). */
  failed: number;
  /** Memories skipped because no provider could embed — statuses untouched. */
  deferred: number;
  /** Honest human-safe summary when nothing was attempted, else null. */
  reason: string | null;
}

/** The AI surface reprocessing needs — the gateway, or an injected fixture provider (tests). */
interface ReprocessingAi {
  embed(request: EmbeddingRequest): Promise<Awaited<ReturnType<AiGateway["embed"]>>>;
}

function reprocessingAi(options: { provider?: MemoryIntelligenceProvider }): ReprocessingAi {
  if (options.provider) {
    return {
      embed: (request) =>
        options.provider!.embed
          ? options.provider!.embed!(request)
          : Promise.resolve({ available: false as const, reason: "This provider cannot embed." }),
    };
  }
  return getAiGateway();
}

/** Regenerate one memory's embedding from its CURRENT canonical representation. */
async function regenerateOne(
  ai: ReprocessingAi,
  userId: string,
  memoryId: string
): Promise<"stored" | "failed" | "deferred"> {
  try {
    const memory = await findMemory(userId, memoryId);
    if (!memory) return "failed"; // vanished mid-run — nothing to embed

    const entityIds = await listEntityIdsForMemory(userId, memoryId);
    const entities = entityIds.length > 0 ? await findEntitiesByIds(userId, entityIds) : [];
    const text = buildEmbeddingText(
      representationFromMemory(
        memory,
        entities.map((entity) => entity.name)
      )
    );

    const embedding = await ai.embed({ text, purpose: "memory", memoryId });
    if (!embedding.available) return "deferred";

    const repository = getAiGateway().embeddings();
    await repository.store(memoryId, embedding.vector, {
      model: embedding.model,
      version: embedding.version,
      dimensions: embedding.dimensions,
    });
    await applyMemoryEnrichment(userId, memoryId, { embeddingStatus: "ready" });
    return "stored";
  } catch (error) {
    console.error(`[embeddings] reprocess failed memory=${memoryId}:`, error);
    await applyMemoryEnrichment(userId, memoryId, { embeddingStatus: "failed" }).catch(
      () => undefined
    );
    return "failed";
  }
}

const EMPTY_REPORT: ReprocessingReport = {
  attempted: 0,
  stored: 0,
  failed: 0,
  deferred: 0,
  reason: null,
};

/**
 * Regenerate the embedding for ONE memory (single-memory repair path).
 * Idempotent: re-running updates the same logical embedding row.
 */
export async function regenerateMemoryEmbedding(
  userId: string,
  memoryId: string,
  options: { provider?: MemoryIntelligenceProvider } = {}
): Promise<ReprocessingReport> {
  const ai = reprocessingAi(options);
  const probe = await ai.embed({ text: ".", purpose: "memory", memoryId });
  if (!probe.available) {
    return {
      ...EMPTY_REPORT,
      deferred: 1,
      reason: `No embedding provider is available in this environment (${probe.reason})`,
    };
  }
  const outcome = await regenerateOne(ai, userId, memoryId);
  return {
    ...EMPTY_REPORT,
    attempted: outcome === "deferred" ? 0 : 1,
    stored: outcome === "stored" ? 1 : 0,
    failed: outcome === "failed" ? 1 : 0,
    deferred: outcome === "deferred" ? 1 : 0,
  };
}

/**
 * Regenerate embeddings for STALE and FAILED memories — edits that
 * marked their vectors pending, and provider errors. Progressive: a
 * bounded batch per call; repeated calls drain the queue without
 * ever blocking normal use (§16).
 */
export async function regenerateStaleEmbeddings(
  userId: string,
  options: { provider?: MemoryIntelligenceProvider } = {}
): Promise<ReprocessingReport> {
  return regenerateBatch(userId, ["pending", "failed"], options);
}

/**
 * Regenerate embeddings for ALL of a user's memories — the
 * model/version-change path (§15). Bounded per call; the repository's
 * (memory, model, version) identity keeps the run idempotent.
 */
export async function regenerateAllEmbeddings(
  userId: string,
  options: { provider?: MemoryIntelligenceProvider } = {}
): Promise<ReprocessingReport> {
  return regenerateBatch(userId, ["none", "pending", "ready", "failed", "deferred"], options);
}

async function regenerateBatch(
  userId: string,
  statuses: Array<"none" | "pending" | "ready" | "deferred" | "failed">,
  options: { provider?: MemoryIntelligenceProvider }
): Promise<ReprocessingReport> {
  const ai = reprocessingAi(options);
  const probe = await ai.embed({ text: ".", purpose: "memory" });
  if (!probe.available) {
    return {
      ...EMPTY_REPORT,
      reason: `No embedding provider is available in this environment (${probe.reason})`,
    };
  }

  const workList = await listMemoriesByEmbeddingStatus(userId, statuses, maxEmbeddingReprocessBatch);
  const report: ReprocessingReport = { ...EMPTY_REPORT };
  for (const memory of workList) {
    const outcome = await regenerateOne(ai, userId, memory.id);
    if (outcome === "stored") report.stored += 1;
    else if (outcome === "failed") report.failed += 1;
    else report.deferred += 1;
  }
  report.attempted = report.stored + report.failed;
  return report;
}

/** Read helper for tests/debug: which memories currently hold a searchable vector. */
export async function memoriesWithEmbeddings(userId: string, memoryIds: string[]): Promise<string[]> {
  const memories = await getMemoriesByIds(userId, memoryIds);
  return memories.filter((memory) => memory.embeddingStatus === "ready").map((memory) => memory.id);
}
