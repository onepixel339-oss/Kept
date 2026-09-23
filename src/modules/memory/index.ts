/**
 * Memory module — the heart of Kept.
 *
 * Owns the full lifecycle of a memory: capture, storage, revision,
 * versioning, recall, and (since Phase 3) the processing-state surface
 * the intelligence pipeline uses. This module is the ONLY place where
 * memories are created, mutated, or interpreted.
 *
 * Layering:
 *   application/  use cases (below) — validation, domain rules, orchestration
 *   domain/       pure rules (deriving titles, what counts as meaningful)
 *   infrastructure/  the only place Prisma meets memories
 *
 * Boundary rules:
 *  - Other modules consume memories ONLY through this file's exports.
 *  - Every function takes an explicit userId (except the pipeline's
 *    atomic claim, which the pipeline may only call after loading the
 *    memory through the owned path); ownership is structural.
 *  - AI proposals enter through here ONLY as already-validated
 *    enrichment/state updates — never directly into the database.
 *
 * Phase 3: the intelligence pipeline (modules/intelligence) composes
 * this module with the entity module and the AI gateway. The memory
 * module itself performs no AI calls.
 *
 * Phase 4: additive read-only retrieval support (getMemoriesByIds,
 * listMemoriesInWindow, summary-inclusive search). Retrieval planning,
 * ranking, and graph traversal live in modules/query — this module
 * still owns every read of memory rows.
 */

export {
  createMemory,
  createMemoryWithSources,
  getMemory,
  findMemory,
  listMemories,
  updateMemory,
  deleteMemory,
  getMemoryVersions,
  claimMemoryForProcessing,
  markMemoryProcessingFailed,
  markMemoryProcessingReady,
  applyMemoryEnrichment,
  applyMemoryStateUpdate,
  getMemoryProcessingStatus,
  getMemoriesByIds,
  listMemoriesInWindow,
  type AiEnrichment,
} from "./application/memory-service";

/*
 * Phase 9 — rich input support. The seed type is plain provenance
 * data (sourceType/rawContent/metadata); the ingestion module decides
 * what went into it. The memory module never parses modalities.
 */
export type { SourceSeed } from "./infrastructure/memory-repository";

/*
 * Phase 6 — exploration support (read-only; the Timeline surface's
 * data path). Dated memories are memories with a KNOWN event date;
 * the kept-date is never substituted, and undated memories are
 * counted honestly instead of being placed with fabricated dates.
 */
export { listDatedMemories, countUndatedMemories } from "./application/memory-service";

/*
 * Phase 8 — embedding lifecycle support (read-only): the bounded work
 * list the intelligence module's reprocessing service consumes. The
 * memory module owns the status; the intelligence module owns the
 * regeneration.
 */
export { listMemoriesByEmbeddingStatus } from "./application/memory-service";

export { deriveTitle, isMeaningfulChange } from "./domain/memory-rules";
