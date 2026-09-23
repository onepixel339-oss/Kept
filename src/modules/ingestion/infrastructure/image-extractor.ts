/**
 * Image extractor (Phase 9 §4–6) — the only place that knows how an
 * uploaded image becomes a normalized ingestion.
 *
 * Order of operations (bounded at every step):
 *   1. size cap (config) — before anything reads the bytes deeply
 *   2. content signature — the claimed MIME is a hint, never trusted
 *   3. decode via sharp — proves the bytes really are a readable image
 *   4. preserve the original (storage) + a small thumbnail
 *   5. ONE vision call proposing { text, description } — validated by
 *      the domain schema (extraction-schemas); never invents facts
 *
 * Honest outcomes (spec §5, §36): capability unavailable → `pending`
 * (the image is kept, extraction retryable); vision error or invalid
 * proposal → `failed` (the image is STILL kept); empty text → `ready`
 * with whatever was truly there. Nothing is ever faked.
 */

import sharp from "sharp";
import { IMAGE_LIMITS, MAX_IMAGE_BYTES } from "@/config/ingestion";
import { getAiGateway, type AiGateway } from "@/lib/ai";
import { buildStorageKey, getStorage } from "@/lib/storage";
import { parseImageExtraction } from "../domain/extraction-schemas";
import {
  assertUploadSize,
  detectImageKind,
  extensionForMime,
  imageMime,
  safeDisplayName,
  type UploadFile,
} from "../domain/validation";
import { clampText, type NormalizedIngestion } from "../domain/ingestion-types";

const VISION_UNAVAILABLE = "Text extraction isn't available right now — the image is kept and can be retried.";
const NOT_AN_IMAGE = "That file doesn't look like a supported image (PNG, JPEG, WebP, or GIF).";
const VISION_FAILED = "The image couldn't be read just now — the original is kept, and you can retry.";

export async function extractFromImage(userId: string, file: UploadFile): Promise<NormalizedIngestion> {
  const warnings: NormalizedIngestion["warnings"] = [];
  const label = safeDisplayName(file.name);

  try {
    assertUploadSize(file.bytes, MAX_IMAGE_BYTES);
  } catch (error) {
    return failed(label, error instanceof Error ? error.message : "That image is too large.", warnings);
  }

  // 1–2. Content signature decides; the claimed type is only a hint.
  const kind = detectImageKind(file.bytes);
  if (!kind) {
    return failed(label, NOT_AN_IMAGE, warnings);
  }
  const mimeType = imageMime(kind);

  // 3. Decode — a corrupted or mislabeled upload stops here.
  let width: number | null = null;
  let height: number | null = null;
  let thumbnail: Buffer | null = null;
  try {
    const image = sharp(file.bytes, { failOn: "error" });
    const metadata = await image.metadata();
    width = metadata.width ?? null;
    height = metadata.height ?? null;
    thumbnail = await sharp(file.bytes)
      .rotate()
      .resize(IMAGE_LIMITS.thumbnailEdge, IMAGE_LIMITS.thumbnailEdge, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
  } catch {
    return failed(label, NOT_AN_IMAGE, warnings);
  }

  // 4. Preserve the original + thumbnail. A storage failure is an
  // ingestion failure — extraction must never outrun preservation.
  const storage = getStorage();
  let originalKey: string | null = null;
  let thumbnailKey: string | null = null;
  try {
    originalKey = buildStorageKey(userId, extensionForMime(mimeType));
    await storage.put(originalKey, file.bytes);
    if (thumbnail) {
      thumbnailKey = buildStorageKey(userId, "webp");
      await storage.put(thumbnailKey, thumbnail);
    }
  } catch {
    return failed(label, "The image couldn't be stored — nothing was lost, please try again.", warnings);
  }

  // 5. One bounded vision call. The gateway reports honestly when the
  // provider has no vision capability — we never fabricate an extraction.
  let attempt: Awaited<ReturnType<AiGateway["extractImage"]>>;
  try {
    attempt = await getAiGateway().extractImage({
      imageBase64: file.bytes.toString("base64"),
      mimeType,
    });
  } catch {
    // Provider failure — the image stays preserved and retryable.
    return failedWithKeys(label, originalKey, thumbnailKey, mimeType, file.bytes.length, VISION_FAILED, width, height, warnings);
  }

  if (!attempt.available) {
    warnings.push({ code: "extraction_unavailable", message: VISION_UNAVAILABLE });
    return pendingResult({ label, originalKey, thumbnailKey, mimeType, sizeBytes: file.bytes.length, width, height, warnings });
  }

  let proposal: ReturnType<typeof parseImageExtraction> = null;
  try {
    proposal = parseImageExtraction(attempt.raw);
  } catch {
    proposal = null;
  }
  if (!proposal) {
    return failedWithKeys(label, originalKey, thumbnailKey, mimeType, file.bytes.length, VISION_FAILED, width, height, warnings);
  }

  const text = clampText(proposal.text, IMAGE_LIMITS.maxTextChars);
  if (text.truncated) {
    warnings.push({ code: "text_truncated", message: "The readable text was longer than what was kept." });
  }
  const description = proposal.description && proposal.description !== "" ? proposal.description : null;

  return {
    sourceType: "image",
    status: "ready",
    extractedContent: text.text !== "" ? text.text : null,
    description,
    label,
    originalKey,
    thumbnailKey,
    url: null,
    mimeType,
    sizeBytes: file.bytes.length,
    error: null,
    warnings,
    metadata: {
      width,
      height,
      storageKey: originalKey,
      thumbnailKey,
      originalFilename: label,
      contentSignature: kind,
      extractionTool: "vision",
      extractionProvider: attempt.provider,
    },
  };
}

function pendingResult(input: {
  label: string;
  originalKey: string | null;
  thumbnailKey: string | null;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  warnings: NormalizedIngestion["warnings"];
}): NormalizedIngestion {
  return {
    sourceType: "image",
    status: "pending",
    extractedContent: null,
    description: null,
    label: input.label,
    originalKey: input.originalKey,
    thumbnailKey: input.thumbnailKey,
    url: null,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    error: null,
    warnings: input.warnings,
    metadata: {
      width: input.width,
      height: input.height,
      storageKey: input.originalKey,
      thumbnailKey: input.thumbnailKey,
      originalFilename: input.label,
      extractionTool: "vision",
    },
  };
}

function failed(label: string, message: string, warnings: NormalizedIngestion["warnings"]): NormalizedIngestion {
  return {
    sourceType: "image",
    status: "failed",
    extractedContent: null,
    description: null,
    label,
    originalKey: null,
    thumbnailKey: null,
    url: null,
    mimeType: null,
    sizeBytes: null,
    error: message,
    warnings,
    metadata: { originalFilename: label },
  };
}

function failedWithKeys(
  label: string,
  originalKey: string | null,
  thumbnailKey: string | null,
  mimeType: string,
  sizeBytes: number,
  message: string,
  width: number | null,
  height: number | null,
  warnings: NormalizedIngestion["warnings"]
): NormalizedIngestion {
  return {
    sourceType: "image",
    status: "failed",
    extractedContent: null,
    description: null,
    label,
    originalKey,
    thumbnailKey,
    url: null,
    mimeType,
    sizeBytes,
    error: message,
    warnings,
    metadata: {
      width,
      height,
      storageKey: originalKey,
      thumbnailKey,
      originalFilename: label,
      extractionTool: "vision",
    },
  };
}
