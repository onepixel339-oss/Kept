/**
 * Shared intelligence-processing types — Phase 3 vocabulary.
 *
 * Processing state is deliberately SEPARATE from memory lifecycle
 * status (`active | archived | superseded`):
 *
 *   memory.status            = does the user want this memory? (lifecycle)
 *   memory.processingStatus  = has the system finished understanding it?
 *
 * A memory that failed processing is still a saved memory. The user's
 * words are never lost to a pipeline failure.
 */

/** Where a memory stands in the intelligence pipeline. */
export const PROCESSING_STATUSES = ["pending", "processing", "ready", "failed"] as const;

export type ProcessingStatus = (typeof PROCESSING_STATUSES)[number];

/**
 * Semantic embedding state for a memory (Phase 8 lifecycle). Every
 * state is honest:
 *  - none      never attempted
 *  - pending   awaiting generation — brand new, stale after an edit,
 *              or queued behind a model/version change (regenerable,
 *              excluded from semantic search while pending)
 *  - ready     a current-model vector exists and is searchable
 *  - deferred  attempted; this environment has no embedding provider
 *  - failed    attempted; the provider errored — retryable
 * The memory remains fully usable in every state. Nothing is faked.
 */
export const EMBEDDING_STATUSES = ["none", "pending", "ready", "deferred", "failed"] as const;

export type EmbeddingStatus = (typeof EMBEDDING_STATUSES)[number];

/**
 * What the decision engine chose to do with a processed memory.
 * The AI proposes evidence; this decision is made by deterministic
 * application rules — never by the model itself.
 */
export const DECISION_ACTIONS = [
  "create",
  "update",
  "merge",
  "link",
  "conflict",
  "ignore",
] as const;

export type DecisionAction = (typeof DECISION_ACTIONS)[number];

/** Outcome status of one processing attempt (a memory_analyses row). */
export const ANALYSIS_STATUSES = ["succeeded", "failed", "rejected"] as const;

export type AnalysisStatus = (typeof ANALYSIS_STATUSES)[number];
