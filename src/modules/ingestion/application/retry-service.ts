/**
 * Retry service (Phase 9 §37) — idempotent re-extraction.
 *
 * A retry NEVER duplicates anything: the same source row is claimed
 * atomically (a concurrent retry sees "busy"), re-read in place, and
 * if it was never linked to a memory, the successful retry creates
 * exactly one memory and links the SAME source. A source already
 * linked to a memory keeps that memory's words exactly as they were
 * kept — retry completes provenance, it never rewrites a memory.
 *
 * Deterministic extractors make a successful retry cheap and stable:
 * the same bytes yield the same text without any AI call (documents,
 * URLs). Images and audio re-propose only when their stored original
 * allows it — identical bytes, identical call, one row.
 */

import { AppError } from "@/lib/api";
import { createMemoryWithSources } from "@/modules/memory";
import { getStorage } from "@/lib/storage";
import type { SourceView } from "@/types/source";
import { composeMemoryContent } from "../domain/compose";
import type { SourceContribution } from "../domain/ingestion-types";
import { extractFromImage } from "../infrastructure/image-extractor";
import { extractFromAudio } from "../infrastructure/audio-transcriber";
import { extractFromDocument } from "../infrastructure/document-extractor";
import { extractFromUrl } from "../infrastructure/url-extractor";
import {
  claimSourceForExtraction,
  countMemoryLinks,
  findLinkedMemoryId,
  findSource,
  listMemorySources,
  toSourceView,
  updateSourceExtraction,
} from "../infrastructure/source-repository";

export interface RetryResult {
  sourceId: string;
  /** The source's extraction state after the retry. */
  status: "ready" | "partial" | "pending" | "failed" | "busy";
  memoryId: string | null;
  sources: SourceView[];
  notices: string[];
}

export async function retrySource(userId: string, sourceId: string): Promise<RetryResult> {
  const source = await findSource(userId, sourceId);
  if (!source) {
    throw new AppError("not_found", "That source could not be found.");
  }
  if (source.sourceType === "user_input" || source.sourceType === "conversation") {
    throw new AppError("validation_failed", "A typed note has nothing to retry.");
  }

  // Already good — idempotent no-op (spec §37).
  if (source.extractionStatus === "ready") {
    const memoryId = await findLinkedMemoryId(userId, source.id);
    const sources = memoryId ? await listMemorySources(userId, memoryId) : [source];
    return {
      sourceId: source.id,
      status: "ready",
      memoryId,
      sources: sources.map(toSourceView),
      notices: [],
    };
  }

  // Claim atomically — concurrent retries collapse into one.
  const claimed = await claimSourceForExtraction(userId, source.id);
  if (!claimed) {
    return { sourceId: source.id, status: "busy", memoryId: null, sources: [], notices: [] };
  }

  const storage = getStorage();
  const metadata = claimed.metadata ?? {};
  const originalKey = claimed.storageKey ?? (typeof metadata.storageKey === "string" ? metadata.storageKey : null);
  const displayName = typeof metadata.originalFilename === "string" ? metadata.originalFilename : claimed.id;

  let extracted: Awaited<ReturnType<typeof extractFromDocument>>;

  if (claimed.sourceType === "image") {
    const bytes = originalKey ? await storage.get(originalKey) : null;
    if (!bytes) {
      extracted = extractionLost("The original image is no longer stored — it cannot be re-read.");
    } else {
      const mimeType =
        typeof metadata.mimeType === "string"
          ? metadata.mimeType
          : originalKey?.endsWith(".png")
            ? "image/png"
            : "image/jpeg";
      extracted = await extractFromImage(userId, { name: displayName, mimeType, bytes });
    }
  } else if (claimed.sourceType === "voice") {
    const bytes = originalKey ? await storage.get(originalKey) : null;
    if (!bytes) {
      extracted = extractionLost("The original recording is no longer stored — it cannot be re-read.");
    } else {
      const mimeType = typeof metadata.mimeType === "string" ? metadata.mimeType : "audio/wav";
      extracted = await extractFromAudio(userId, { name: displayName, mimeType, bytes }, null);
    }
  } else if (claimed.sourceType === "file") {
    const bytes = originalKey ? await storage.get(originalKey) : null;
    if (!bytes) {
      extracted = extractionLost("The original file is no longer stored — it cannot be re-read.");
    } else {
      extracted = await extractFromDocument(userId, { name: displayName, mimeType: "application/octet-stream", bytes });
    }
  } else {
    // URL — re-read the preserved link.
    const url = typeof metadata.url === "string" && metadata.url !== "" ? metadata.url : claimed.rawContent;
    extracted = await extractFromUrl(url);
  }

  // Fold the fresh result into the SAME row — no new source, ever.
  const mergedMetadata: Record<string, unknown> = {
    ...metadata,
    ...extracted.metadata,
    ...(extracted.warnings.length > 0 ? { warnings: extracted.warnings } : {}),
  };

  const updated = await updateSourceExtraction(userId, claimed.id, {
    rawContent:
      extracted.extractedContent ??
      extracted.description ??
      (claimed.sourceType === "url" ? (extracted.url ?? claimed.rawContent) : claimed.rawContent),
    extractionStatus: extracted.status,
    extractionError: extracted.error,
    metadata: mergedMetadata,
    storageKey: extracted.originalKey ?? claimed.storageKey,
  });

  const linkedMemoryId = await findLinkedMemoryId(userId, updated.id);

  // Unlinked + now readable → create exactly one memory, attach the
  // SAME source. Content = whatever the retry honestly produced.
  if (!linkedMemoryId && (extracted.extractedContent || extracted.description)) {
    const contributions: SourceContribution[] = extracted.extractedContent
      ? [{ sourceType: updated.sourceType, text: extracted.extractedContent, origin: "extracted" as const }]
      : [{ sourceType: updated.sourceType, text: extracted.description!, origin: "machine_description" as const }];
    const composed = composeMemoryContent(contributions);
    if (composed.content) {
      const memory = await createMemoryWithSources(userId, { originalContent: composed.content }, [], {
        attachSourceIds: [updated.id],
      });
      const sources = await listMemorySources(userId, memory.id);
      return {
        sourceId: updated.id,
        status: extracted.status,
        memoryId: memory.id,
        sources: sources.map(toSourceView),
        notices: extracted.warnings.map((w) => w.message),
      };
    }
  }

  return {
    sourceId: updated.id,
    status: extracted.status,
    memoryId: linkedMemoryId,
    sources: [toSourceView(updated)],
    notices: extracted.warnings.map((w) => w.message),
  };
}

/** The preserved original vanished — an honest dead end, never a fake extraction. */
function extractionLost(message: string): Awaited<ReturnType<typeof extractFromDocument>> {
  return {
    sourceType: "file",
    status: "failed",
    extractedContent: null,
    description: null,
    label: null,
    originalKey: null,
    thumbnailKey: null,
    url: null,
    mimeType: null,
    sizeBytes: null,
    error: message,
    warnings: [],
    metadata: {},
  };
}
