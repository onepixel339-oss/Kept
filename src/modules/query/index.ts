/**
 * Query module — how the user finds things again.
 *
 * The retrieval engine (Phase 4) and the ask pipeline (Phase 5). The
 * pipeline, top to bottom:
 *
 *   question → understandQuery (AI proposal, validated; deterministic
 *              fallback) → planQuery → retrievers (structured,
 *              keyword, entity, temporal, graph; semantic deferred)
 *              → merge → rank → buildContext → REASONING
 *
 * Phase 5 completes the flow: the ContextPack is handed to the
 * reasoning module (modules/reasoning), which produces the grounded,
 * verified answer. This module routes the pipeline onto the user's
 * EXPLICIT chat intents first (deterministic detection): capture
 * routes to the Memory Orchestrator through the memory module's
 * public API, deletion runs the existing deletion flow when the
 * target is unambiguous, and count questions answer from the
 * database — none of them involve a model.
 *
 * Owns:
 *  - query understanding validation (zod — where model output becomes
 *    trusted) and the deterministic fallback understanding
 *  - the Query Planner (deterministic, inspectable, bounded) and its
 *    bounded re-planning loop
 *  - the Retriever abstraction and every retriever implementation
 *  - candidate merging, deterministic ranking, context building
 *  - explicit chat-intent detection (capture / deletion / count) and
 *    the ask pipeline's intent routing
 *
 * Depends on:
 *  - `modules/memory`, `modules/entity`, `modules/conversation`,
 *    `modules/reasoning` (public APIs only)
 *  - `lib/ai` (query understanding + grounded answers via the gateway
 *    — the only door)
 *
 * Boundary rules:
 *  - Ownership is structural: every pipeline run carries one userId,
 *    every retriever's reads are user-scoped. No cross-user search,
 *    resolution, or traversal is representable.
 *  - No fake semantic search: embeddings are deferred, and the system
 *    says so (retrieval continues honestly without them).
 *  - The planner is never bypassed: there is no code path from a raw
 *    question straight to the database.
 *  - The model never mutates memory: capture/deletion run only on
 *    deterministic detection of the user's explicit words, through
 *    the memory module's public APIs.
 */

export {
  searchMemorySpace,
  type SearchSpaceResult,
} from "./application/search-service";

export {
  askMemorySpace,
  type AskRequest,
  type AskResult,
} from "./application/ask-service";

export { runRetrieval, type RetrievalOutcome, type OrchestratorOptions } from "./application/orchestrator";
export type { Retriever, RetrievalInput } from "./application/retrieval-types";

export {
  planQuery,
  widenPlan,
  type PlanRequest,
} from "./domain/planner";

export {
  parseQueryUnderstanding,
  queryUnderstandingProposalSchema,
  type QueryUnderstanding,
} from "./domain/understanding";

export { buildFallbackUnderstanding, detectIntent } from "./domain/fallback-understanding";
export { extractQueryTerms } from "./domain/terms";
export { resolveTimeExpression, type ResolvedTimeWindow } from "./domain/time-resolution";
export { mergeCandidates } from "./domain/merge";
export { rankCandidates, type RankedInput } from "./domain/ranking";
export { buildContext, type BuildContextInput } from "./domain/context-builder";
export { semanticAvailable, SemanticRetriever } from "./application/retrievers/semantic";

export {
  detectChatIntent,
  detectMemoryCapture,
  detectDeletionRequest,
  detectCountQuestion,
  type ChatIntentKind,
  type DetectedChatIntent,
} from "./domain/chat-intents";
