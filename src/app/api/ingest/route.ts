/**
 * /api/ingest — the rich-input front door (Phase 9).
 *
 * One endpoint, one pipeline: multipart form data in, normalized
 * ingestion out. Every modality (image, audio, file, url — and text,
 * for clients that prefer the unified path) converges here and then
 * flows into the existing memory pipeline exactly like typed input.
 *
 * Security posture:
 *  - authenticated session required; Same-Origin verified by the handler
 *  - rate limited (ingest rule) — uploads and extraction are expensive
 *  - size caps enforced from the Content-Length header BEFORE the body
 *    is parsed, then per-file again inside the extractors
 *  - the client-declared MIME/extension is a hint; content signatures
 *    decide (validation.ts)
 *
 * The response is honest immediately: saved sources, extraction
 * states, and the memory id when there were words to keep.
 */

import { after } from "next/server";
import { apiHandler, ok, AppError } from "@/lib/api";
import { requireCurrentUserId } from "@/modules/user";
import { checkRateLimit } from "@/modules/user/infrastructure/rate-limit";
import {
  ingestImage,
  ingestAudio,
  ingestFile,
  ingestUrl,
  ingestText,
  type UploadPayload,
} from "@/modules/ingestion";
import { processMemory } from "@/modules/intelligence";
import { findMemory } from "@/modules/memory";
import {
  MAX_IMAGE_BYTES,
  MAX_AUDIO_BYTES,
  MAX_FILE_BYTES,
} from "@/config/ingestion";

const KINDS = ["text", "image", "audio", "file", "url"] as const;
type Kind = (typeof KINDS)[number];

function sizeCapFor(kind: Kind): number {
  switch (kind) {
    case "image":
      return MAX_IMAGE_BYTES;
    case "audio":
      return MAX_AUDIO_BYTES;
    case "file":
      return MAX_FILE_BYTES;
    default:
      return Number.MAX_SAFE_INTEGER;
  }
}

function optionalString(value: FormDataEntryValue | null): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export const POST = apiHandler(async (request: Request) => {
  const userId = await requireCurrentUserId();

  const rl = checkRateLimit("ingest", userId);
  if (!rl.allowed) {
    throw new AppError(
      "rate_limited",
      "That's a lot at once — give it a moment and try again."
    );
  }

  // Reject oversized bodies before parsing them into memory.
  const contentLength = Number.parseInt(request.headers.get("content-length") ?? "0", 10);
  const bodyCap = 30 * 1024 * 1024; // the largest single-file cap, plus form overhead
  if (Number.isFinite(contentLength) && contentLength > bodyCap) {
    throw new AppError("validation_failed", "That upload is too large.");
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new AppError("validation_failed", "The upload could not be read.");
  }

  const kindValue = form.get("kind");
  const kind = typeof kindValue === "string" && (KINDS as readonly string[]).includes(kindValue) ? (kindValue as Kind) : null;
  if (!kind) {
    throw new AppError("validation_failed", "What kind of memory is this? (text, image, audio, file, or url)");
  }

  const requestId = optionalString(form.get("requestId"));
  const caption = optionalString(form.get("caption"));

  let result;
  if (kind === "text") {
    const text = form.get("text");
    if (typeof text !== "string") {
      throw new AppError("validation_failed", "The text to keep is missing.");
    }
    result = await ingestText(userId, { text, requestId });
  } else if (kind === "url") {
    const url = form.get("url");
    if (typeof url !== "string") {
      throw new AppError("validation_failed", "The link to keep is missing.");
    }
    result = await ingestUrl(userId, { url, note: caption, requestId });
  } else {
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new AppError("validation_failed", "The file is missing from the upload.");
    }
    const cap = sizeCapFor(kind);
    if (file.size > cap) {
      throw new AppError("validation_failed", `That file is larger than the ${Math.floor(cap / (1024 * 1024))} MB limit.`);
    }
    const bytes = Buffer.from(await file.arrayBuffer());
    const payload: UploadPayload = { name: file.name || "upload", mimeType: file.type || "application/octet-stream", bytes };

    if (kind === "image") {
      result = await ingestImage(userId, payload, { caption, requestId });
    } else if (kind === "audio") {
      const duration = Number.parseFloat(String(form.get("durationSeconds") ?? ""));
      result = await ingestAudio(userId, payload, {
        caption,
        requestId,
        durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : null,
      });
    } else {
      result = await ingestFile(userId, payload, { caption, requestId });
    }
  }

  // Words were kept → the existing intelligence pipeline runs, quietly,
  // after the response lands. Same contract as typed memories.
  if (result.memoryId) {
    after(async () => {
      try {
        const memory = await findMemory(userId, result.memoryId!);
        if (memory) {
          await processMemory(memory);
        }
      } catch (error) {
        console.error("[intelligence] background processing failed after ingestion:", error);
      }
    });
  }

  return ok(result, 201);
});
