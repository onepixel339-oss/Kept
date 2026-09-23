/**
 * AI gateway — re-exports. The implementation lives in gateway.ts;
 * this file keeps the Phase 1 import path (`@/lib/ai`) stable.
 */

export {
  getAiGateway,
  setAiGatewayForTests,
  type AiGateway,
  DeferredEmbeddingRepository,
  EmbeddingUnavailableError,
  SqliteEmbeddingRepository,
  cosineSimilarity,
  decodeVector,
  encodeVector,
  type EmbeddingMetadata,
  type EmbeddingRepository,
  type EmbeddingSearchHit,
} from "./gateway";

export type * from "./types";
export type * from "./intelligence-types";
export type * from "./ingestion-types";
export type * from "./query-types";
export type * from "./reasoning-types";
export type { UnderstandQueryResult, ReasoningAttemptResult } from "./gateway";
