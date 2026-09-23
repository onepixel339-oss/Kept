/**
 * The ingestion service — the ONE pipeline every input direction
 * converges into (Phase 9 GOAL):
 *
 *   INPUT → INGESTION (extractors) → NORMALIZATION (NormalizedIngestion)
 *         → MEMORY PROCESSING (memory module) → MEMORY INTELLIGENCE
 *
 * There is exactly one Memory Orchestrator. This service adds no
 * second memory system: it extracts (via infrastructure), composes
 * the memory's words (domain/compose), and hands everything to the
 * memory module's public API. Text input reaches the SAME pipeline —
 * ingestText is the existing flow expressed through the abstraction.
 *
 * Idempotency (spec §37): a stable client `requestId` maps to one
 * source (dedupKey) — repeating a request never duplicates sources,
 * memories, or entities.
 */

import { AppError } from "@/lib/api";
import { MAX_TEXT_BYTES } from "@/config/ingestion";
import { createMemoryWithSources, type SourceSeed } from "@/modules/memory";
import type { SourceView } from "@/types/source";
import { composeMemoryContent } from "../domain/compose";
import { clampText, type IngestionKind, type NormalizedIngestion, type SourceContribution, type UploadPayload } from "../domain/ingestion-types";
import { extractFromImage } from "../infrastructure/image-extractor";
import { extractFromAudio } from "../infrastructure/audio-transcriber";
import { extractFromDocument } from "../infrastructure/document-extractor";
import { extractFromUrl } from "../infrastructure/url-extractor";
import {
  findSource,
  findSourceByDedupKey,
  listMemorySources,
  toSourceView,
} from "../infrastructure/source-repository";

export interface IngestRequestBase {
  /** Stable client request id — the idempotency key (optional but recommended). */
  requestId?: string | null;
}

export interface TextIngestRequest extends IngestRequestBase {
  text: string;
}

export interface RichIngestRequest extends IngestRequestBase {
  /** The user's own words accompanying the input (caption/note). */
  caption?: string | null;
}

export interface AudioIngestRequest extends RichIngestRequest {
  /** Client-reported duration hint, when the browser knows it. */
  durationSeconds?: number | null;
}

export interface UrlIngestRequest extends IngestRequestBase {
  url: string;
  note?: string | null;
}

export interface IngestionResult {
  memoryId: string | null;
  sources: SourceView[];
  deduplicated: boolean;
  /** Quiet, honest lines the UI may show. */
  notices: string[];
}

function assertText(text: string, what: string): string {
  const trimmed = text.trim();
  if (trimmed === "") {
    throw new AppError("validation_failed", `Something to keep is needed — ${what} cannot be empty.`);
  }
  if (Buffer.byteLength(trimmed, "utf8") > MAX_TEXT_BYTES) {
    throw new AppError("validation_failed", `That ${what} is longer than what can be kept in one piece.`);
  }
  return trimmed;
}

/** Early dedup: a retried request keeps its original outcome (spec §37). */
async function deduplicatedOutcome(userId: string, requestId: string | null | undefined): Promise<IngestionResult | null> {
  if (!requestId) return null;
  const existing = await findSourceByDedupKey(userId, requestId);
  if (!existing) return null;
  return {
    memoryId: existing.referenceId,
    sources: [toSourceView(existing)],
    deduplicated: true,
    notices: [],
  };
}

function seedFromNormalized(normalized: NormalizedIngestion, dedupKey: string | null): SourceSeed {
  const metadata: Record<string, unknown> = {
    ...normalized.metadata,
    ...(normalized.warnings.length > 0 ? { warnings: normalized.warnings } : {}),
    ...(normalized.sizeBytes !== null ? { sizeBytes: normalized.sizeBytes } : {}),
    ...(normalized.mimeType ? { mimeType: normalized.mimeType } : {}),
  };
  return {
    sourceType: normalized.sourceType,
    rawContent:
      normalized.extractedContent ??
      normalized.description ??
      normalized.url ??
      normalized.label ??
      "",
    metadata,
    storageKey: normalized.originalKey,
    extractionStatus: normalized.status,
    extractionError: normalized.error,
    dedupKey,
  };
}

function userTextSeed(text: string): SourceSeed {
  return { sourceType: "user_input", rawContent: text, extractionStatus: "ready" };
}

/** Persist the normalized result + compose the memory, when there are words. */
async function persistIngestion(
  userId: string,
  normalized: NormalizedIngestion,
  contributions: SourceContribution[],
  dedupKey: string | null
): Promise<IngestionResult> {
  const composed = composeMemoryContent(contributions);

  const seeds: SourceSeed[] = [];
  // The text path's normalized source IS the user's words — one row,
  // not two. Rich input gets a user-words seed beside the source seed.
  const isTextPath = normalized.sourceType === "user_input";
  const userWords = isTextPath
    ? undefined
    : contributions.find((c) => c.origin === "user_text" && c.text);
  if (userWords) seeds.push(userTextSeed(userWords.text!));
  seeds.push(seedFromNormalized(normalized, dedupKey));

  if (composed.content && composed.content.trim() !== "") {
    // One atomic creation: memory + v1 + every provenance source.
    const memory = await createMemoryWithSources(
      userId,
      { originalContent: composed.content },
      seeds
    );
    const sources = await listMemorySources(userId, memory.id);
    return {
      memoryId: memory.id,
      sources: sources.map(toSourceView),
      deduplicated: false,
      notices: noticesFromNormalized(normalized),
    };
  }

  // No words anywhere — the source alone is preserved (spec §36). It
  // lives unlinked until a successful retry gives it a memory. The
  // source row is written directly here: a wordless memory must not
  // exist, so the atomic-with-memory path does not apply.
  const { db } = await import("@/lib/db");
  const seed = seeds[seeds.length - 1];
  const row = await db.source.create({
    data: {
      userId,
      sourceType: seed.sourceType,
      rawContent: seed.rawContent,
      metadata: seed.metadata ? JSON.stringify(seed.metadata) : null,
      storageKey: seed.storageKey ?? null,
      extractionStatus: seed.extractionStatus ?? "pending",
      extractionError: seed.extractionError ?? null,
      dedupKey: seed.dedupKey ?? null,
    },
  });
  const source = await findSource(userId, row.id);
  return {
    memoryId: null,
    sources: source ? [toSourceView(source)] : [],
    deduplicated: false,
    notices: noticesFromNormalized(normalized),
  };
}

function noticesFromNormalized(normalized: NormalizedIngestion): string[] {
  return normalized.warnings.map((warning) => warning.message);
}

/* ————————————————— Public ingestion operations ————————————————— */

export async function ingestText(userId: string, request: TextIngestRequest): Promise<IngestionResult> {
  const dedup = await deduplicatedOutcome(userId, request.requestId);
  if (dedup) return dedup;

  const text = assertText(request.text, "a memory");
  const bounded = clampText(text, MAX_TEXT_BYTES);

  const normalized: NormalizedIngestion = {
    sourceType: "user_input",
    status: "ready",
    extractedContent: bounded.text,
    description: null,
    label: null,
    originalKey: null,
    thumbnailKey: null,
    url: null,
    mimeType: null,
    sizeBytes: Buffer.byteLength(bounded.text, "utf8"),
    error: null,
    warnings: [],
    metadata: { contentOrigin: "user_text" },
  };

  return persistIngestion(userId, normalized, [{ sourceType: "user_input", text: bounded.text, origin: "user_text" }], request.requestId ?? null);
}

export async function ingestImage(userId: string, file: UploadPayload, request: RichIngestRequest): Promise<IngestionResult> {
  const dedup = await deduplicatedOutcome(userId, request.requestId);
  if (dedup) return dedup;

  const caption = request.caption?.trim() ? request.caption.trim() : null;
  const normalized = await extractFromImage(userId, file);

  const contributions: SourceContribution[] = [];
  if (caption) contributions.push({ sourceType: "user_input", text: caption, origin: "user_text" });
  if (normalized.extractedContent) contributions.push({ sourceType: "image", text: normalized.extractedContent, origin: "extracted" });
  if (!normalized.extractedContent && normalized.description) {
    contributions.push({ sourceType: "image", text: normalized.description, origin: "machine_description" });
  }

  return persistIngestion(userId, normalized, contributions, request.requestId ?? null);
}

export async function ingestAudio(userId: string, file: UploadPayload, request: AudioIngestRequest): Promise<IngestionResult> {
  const dedup = await deduplicatedOutcome(userId, request.requestId);
  if (dedup) return dedup;

  const caption = request.caption?.trim() ? request.caption.trim() : null;
  const normalized = await extractFromAudio(userId, file, request.durationSeconds ?? null);

  const contributions: SourceContribution[] = [];
  if (caption) contributions.push({ sourceType: "user_input", text: caption, origin: "user_text" });
  if (normalized.extractedContent) contributions.push({ sourceType: "voice", text: normalized.extractedContent, origin: "extracted" });

  return persistIngestion(userId, normalized, contributions, request.requestId ?? null);
}

export async function ingestFile(userId: string, file: UploadPayload, request: RichIngestRequest): Promise<IngestionResult> {
  const dedup = await deduplicatedOutcome(userId, request.requestId);
  if (dedup) return dedup;

  const caption = request.caption?.trim() ? request.caption.trim() : null;
  const normalized = await extractFromDocument(userId, file);

  const contributions: SourceContribution[] = [];
  if (caption) contributions.push({ sourceType: "user_input", text: caption, origin: "user_text" });
  if (normalized.extractedContent) contributions.push({ sourceType: "file", text: normalized.extractedContent, origin: "extracted" });

  return persistIngestion(userId, normalized, contributions, request.requestId ?? null);
}

export async function ingestUrl(userId: string, request: UrlIngestRequest): Promise<IngestionResult> {
  const dedup = await deduplicatedOutcome(userId, request.requestId);
  if (dedup) return dedup;

  const note = request.note?.trim() ? request.note.trim() : null;
  const normalized = await extractFromUrl(request.url);

  const contributions: SourceContribution[] = [];
  if (note) contributions.push({ sourceType: "user_input", text: note, origin: "user_text" });
  if (normalized.extractedContent) contributions.push({ sourceType: "url", text: normalized.extractedContent, origin: "extracted" });

  return persistIngestion(userId, normalized, contributions, request.requestId ?? null);
}

export type { IngestionKind };
