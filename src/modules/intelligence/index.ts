/**
 * Intelligence module — the Memory Intelligence pipeline (Phase 3).
 *
 * Makes stored memories intelligently understood and maintained, under
 * the product's prime directive:
 *
 *     AI proposes → application validates → domain logic decides →
 *     database persists.
 *
 * Owns:
 *  - the processing pipeline (analyze → resolve → compare → decide →
 *    apply) and its failure/retry semantics
 *  - AI output validation (zod schemas — the boundary where model
 *    output becomes trustworthy)
 *  - entity resolution (deterministic-first, ambiguity preserved)
 *  - the decision engine (CREATE/UPDATE/MERGE/LINK/CONFLICT/IGNORE —
 *    deterministic rules over AI evidence, never the model's call)
 *  - processing state and analysis provenance (memory_analyses)
 *
 * Depends on:
 *  - `modules/memory`, `modules/entity` (public APIs only)
 *  - `lib/ai` (the gateway — the only door to providers)
 *  - `lib/db` (its own analyses table only)
 *
 * Boundary rules:
 *  - AI never writes: every write goes through the memory/entity
 *    public APIs, which enforce ownership and integrity themselves.
 *  - No Phase 4 behavior lives here: no query planner, no semantic
 *    search, no chat, no traversal. Retrieval exists only to feed
 *    processing, and it is bounded and keyword-based.
 *
 * Phase 8 adds the embedding lifecycle to this module's ownership:
 *  - the canonical semantic representation of a memory (domain)
 *  - the embedding attempt at the end of the processing pipeline
 *  - the internal reprocessing service (stale/failed/model-change
 *    regeneration — bounded, idempotent, honest about unavailability)
 */

export {
  processMemory,
  pipelineAiFromProvider,
  type ProcessOptions,
  type ProcessResult,
  type PipelineAi,
} from "./application/pipeline";

export { decide } from "./domain/decision-engine";
export { resolveEntity, resolveCandidateEntities } from "./domain/entity-resolution";
export { parseProposal, analysisProposalSchema, comparisonProposalSchema } from "./domain/ai-schemas";
export { extractKeywords, keywordOverlap } from "./application/retrieval";

export { findLatestAnalysis } from "./infrastructure/analysis-repository";

/* Phase 8 — embedding representation + lifecycle. */
export {
  buildEmbeddingText,
  representationFromMemory,
  EMBEDDING_REPRESENTATION_VERSION,
  type EmbeddingRepresentationInput,
} from "./domain/embedding-representation";
export {
  regenerateMemoryEmbedding,
  regenerateStaleEmbeddings,
  regenerateAllEmbeddings,
  maxEmbeddingReprocessBatch,
  type ReprocessingReport,
} from "./application/embedding-reprocessing";
