/**
 * Ingestion domain types — the normalized shape every modality
 * converges into (Phase 9 CORE RULE).
 *
 * Nothing here knows where bytes came from or how they were parsed.
 * The extractors (infrastructure) produce these; the ingestion service
 * turns them into sources + memory through the memory module's public
 * API. There is exactly one ingestion pipeline and one Memory
 * Orchestrator — rich input adds no second memory system.
 */

import type { ContentOrigin, SourceType } from "@/types/source";

export type IngestionKind = "text" | "image" | "audio" | "file" | "url";

/** One uploaded file, already bounded by the route (never streamed past limits). */
export interface UploadPayload {
  /** Original client filename (display only — never a storage path). */
  name: string;
  /** Client-declared MIME type (untrusted; validated against content). */
  mimeType: string;
  /** File bytes, already size-capped. */
  bytes: Buffer;
}

/** A warning worth surfacing quietly — never a failure on its own. */
export interface IngestionWarning {
  code: string;
  message: string;
}

/**
 * The normalized ingestion result for one modality attempt.
 * `status` is the source-level extraction state (spec §2):
 * ready | partial | pending | failed — `processing` exists only
 * transiently mid-run and never persists.
 */
export interface NormalizedIngestion {
  sourceType: SourceType;
  status: "ready" | "partial" | "pending" | "failed";
  /** Extracted/transcribed/typed text — what the memory pipeline receives. */
  extractedContent: string | null;
  /** One factual sentence of what the source shows (images without text). */
  description: string | null;
  /** Human-safe label: original filename or page title. */
  label: string | null;
  /** The preserved original's storage key (opaque), when one is kept. */
  originalKey: string | null;
  /** A derived thumbnail's storage key, when one was made. */
  thumbnailKey: string | null;
  /** For URL sources: the original public URL. */
  url: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  /** Human-safe failure reason when status = failed. */
  error: string | null;
  warnings: IngestionWarning[];
  /** Structured metadata persisted on the source row (JSON). */
  metadata: Record<string, unknown>;
}

/** What one source contributed to the memory's words. */
export interface SourceContribution {
  sourceType: SourceType;
  /** The text this source contributed (may be null — e.g. failed extraction). */
  text: string | null;
  origin: ContentOrigin;
}

export interface IngestionOutcome {
  /** The created memory, or null when nothing readable was extracted. */
  memoryId: string | null;
  /** The preserved source ids, in creation order. */
  sourceIds: string[];
  /** True when an existing source (same dedup key) satisfied the request. */
  deduplicated: boolean;
}

/** Bounded text rule: what extraction keeps at most, per modality. */
export function clampText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}
