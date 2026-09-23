/**
 * Shared source types — provenance. Where a memory came from.
 *
 * Phase 2 introduced provenance with only user_input in active use.
 * Phase 9 activates the rich input directions (image, voice, file,
 * url) behind the unified ingestion pipeline: every modality produces
 * a normalized Source row — the preserved original, its extracted
 * text, and an honest extraction state — and links to memories
 * through memory_sources (many-to-many; see prisma/schema.prisma).
 */

export const SOURCE_TYPES = [
  "user_input",
  "file",
  "image",
  "voice",
  "url",
  "conversation",
] as const;

export type SourceType = (typeof SOURCE_TYPES)[number];

/** The source type created when a user types a memory by hand. */
export const DEFAULT_SOURCE_TYPE: SourceType = "user_input";

/**
 * Extraction state of a source — deliberately separate from any
 * memory lifecycle status (spec §18: a memory can be active while its
 * input processing is partial).
 *
 *   ready      nothing left to extract (typed text; a fetched page)
 *   partial    useful text extracted, some enhancement failed
 *   pending    extractable later (capability unavailable right now)
 *   processing extraction is running (transient)
 *   failed     extraction failed; the original is preserved, retryable
 */
export const EXTRACTION_STATUSES = [
  "pending",
  "processing",
  "ready",
  "partial",
  "failed",
] as const;

export type ExtractionStatus = (typeof EXTRACTION_STATUSES)[number];

/**
 * Where a memory's words came from — recorded in source/memory
 * metadata so "the user's own words" and "read from the user's own
 * file" stay distinguishable.
 */
export const CONTENT_ORIGINS = [
  "user_text",
  "extracted",
  "user_text_plus_extracted",
  "machine_description",
] as const;

export type ContentOrigin = (typeof CONTENT_ORIGINS)[number];

export interface Source {
  id: string;
  userId: string;
  sourceType: SourceType;
  /** The original captured content, verbatim (typed text, transcript, or extracted text). */
  rawContent: string;
  /** What this source produced (e.g. the memory id). */
  referenceId: string | null;
  /** Free-form structured metadata. JSON object in application code. */
  metadata: Record<string, unknown> | null;
  /** Extraction state — honest at every step. */
  extractionStatus: ExtractionStatus;
  /** Stable, human-safe extraction failure reason; never raw internals. */
  extractionError: string | null;
  /** Opaque storage-seam key for the preserved original; never a filesystem path. */
  storageKey: string | null;
  /** Stable client request id for idempotent ingestion. */
  dedupKey: string | null;
  createdAt: Date;
}

/** Source shape served to the UI — no storage keys, no internals. */
export interface SourceView {
  id: string;
  sourceType: SourceType;
  extractionStatus: ExtractionStatus;
  extractionError: string | null;
  /** The extracted/transcribed/typed text behind the source. */
  content: string | null;
  /** Original filename or page title, when one exists. */
  label: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  /** Whether a viewable original is stored (image preview / audio playback / download). */
  hasOriginal: boolean;
  /** Whether a small thumbnail is stored (images). */
  hasThumbnail: boolean;
  /** For URL sources: the original public URL. */
  url: string | null;
  createdAt: string;
}
