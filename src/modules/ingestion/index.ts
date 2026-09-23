/**
 * Ingestion module (Phase 9) — rich memory input & unified ingestion.
 *
 * Every input direction (text, image, voice, documents, public URLs)
 * converges into ONE pipeline here, then flows into the existing
 * Memory Orchestrator. This module owns:
 *   - the normalized ingestion result (domain/ingestion-types)
 *   - extraction providers' orchestration (infrastructure/*-extractor)
 *   - storage-backed preservation of originals (via lib/storage)
 *   - source provenance reads + idempotent retry
 *
 * It never creates a second memory system: memory creation goes only
 * through the memory module's public API, and the AI is only ever
 * reached through the gateway (lib/ai).
 */

export {
  ingestText,
  ingestImage,
  ingestAudio,
  ingestFile,
  ingestUrl,
  type IngestionResult,
  type TextIngestRequest,
  type RichIngestRequest,
  type AudioIngestRequest,
  type UrlIngestRequest,
} from "./application/ingestion-service";

export { retrySource, type RetryResult } from "./application/retry-service";

export {
  findSource,
  listMemorySources,
  toSourceView,
} from "./infrastructure/source-repository";

export type { UploadPayload } from "./domain/ingestion-types";
