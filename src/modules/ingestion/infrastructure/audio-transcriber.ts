/**
 * Audio extractor (Phase 9 §7–9) — the only place that knows how a
 * voice recording becomes a normalized ingestion.
 *
 * The original audio is ALWAYS preserved first (storage), and the
 * transcript is stored separately from it — never a replacement
 * (spec §7). Transcription goes through the gateway; when the
 * provider cannot transcribe, the result is honest `pending` with the
 * audio intact (spec §8) — never an invented transcript.
 *
 * Duration metadata is parsed from WAV headers server-side; other
 * formats rely on the client-supplied hint, stored as client-reported.
 */

import { AUDIO_LIMITS, MAX_AUDIO_BYTES } from "@/config/ingestion";
import { getAiGateway } from "@/lib/ai";
import { buildStorageKey, getStorage } from "@/lib/storage";
import {
  assertUploadSize,
  audioMime,
  detectAudioKind,
  extensionForMime,
  safeDisplayName,
  type UploadFile,
} from "../domain/validation";
import { clampText, type NormalizedIngestion } from "../domain/ingestion-types";

const NOT_AUDIO = "That file doesn't look like supported audio (WAV, MP3, M4A, WebM, or OGG).";
const TRANSCRIBE_UNAVAILABLE = "Transcription isn't available right now — the recording is kept and can be retried.";
const TRANSCRIBE_FAILED = "The recording couldn't be transcribed just now — it is kept, and you can retry.";

/** Parse a WAV file's duration by walking its chunks. Null when unclear. */
function wavDurationSeconds(bytes: Buffer): number | null {
  try {
    if (bytes.length < 44) return null;
    if (bytes.subarray(0, 4).toString("latin1") !== "RIFF") return null;
    if (bytes.subarray(8, 12).toString("latin1") !== "WAVE") return null;
    let offset = 12;
    let byteRate: number | null = null;
    let dataSize: number | null = null;
    while (offset + 8 <= bytes.length) {
      const chunkId = bytes.subarray(offset, offset + 4).toString("latin1");
      const chunkSize = bytes.readUInt32LE(offset + 4);
      if (chunkId === "fmt ") {
        byteRate = bytes.readUInt32LE(offset + 16);
      } else if (chunkId === "data") {
        dataSize = Math.min(chunkSize, bytes.length - offset - 8);
        break;
      }
      offset += 8 + chunkSize + (chunkSize % 2);
    }
    if (!byteRate || !dataSize || byteRate <= 0) return null;
    const seconds = dataSize / byteRate;
    return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : null;
  } catch {
    return null;
  }
}

export async function extractFromAudio(
  userId: string,
  file: UploadFile,
  clientDurationSeconds: number | null
): Promise<NormalizedIngestion> {
  const warnings: NormalizedIngestion["warnings"] = [];
  const label = safeDisplayName(file.name);

  try {
    assertUploadSize(file.bytes, MAX_AUDIO_BYTES);
  } catch (error) {
    return failed(label, error instanceof Error ? error.message : "That recording is too large.", warnings);
  }

  const kind = detectAudioKind(file.bytes);
  if (!kind) {
    return failed(label, NOT_AUDIO, warnings);
  }
  const mimeType = audioMime(kind);

  // Preserve the original BEFORE any extraction — a failure below must
  // never lose the only copy (spec §36).
  const storage = getStorage();
  let originalKey: string | null = null;
  try {
    originalKey = buildStorageKey(userId, extensionForMime(mimeType));
    await storage.put(originalKey, file.bytes);
  } catch {
    return failed(label, "The recording couldn't be stored — nothing was lost, please try again.", warnings);
  }

  const wavSeconds = kind === "wav" ? wavDurationSeconds(file.bytes) : null;
  const durationSeconds = wavSeconds ?? clientDurationSeconds;
  const durationSource = wavSeconds ? "parsed" : clientDurationSeconds ? "client-reported" : null;

  const attempt = await getAiGateway().transcribe({
    audioBase64: file.bytes.toString("base64"),
    mimeType,
  }).catch(() => null);

  if (!attempt) {
    return {
      sourceType: "voice",
      status: "failed",
      extractedContent: null,
      description: null,
      label,
      originalKey,
      thumbnailKey: null,
      url: null,
      mimeType,
      sizeBytes: file.bytes.length,
      error: TRANSCRIBE_FAILED,
      warnings,
      metadata: audioMetadata(originalKey, label, durationSeconds, durationSource),
    };
  }

  if (!attempt.available) {
    warnings.push({ code: "transcription_unavailable", message: TRANSCRIBE_UNAVAILABLE });
    return {
      sourceType: "voice",
      status: "pending",
      extractedContent: null,
      description: null,
      label,
      originalKey,
      thumbnailKey: null,
      url: null,
      mimeType,
      sizeBytes: file.bytes.length,
      error: null,
      warnings,
      metadata: audioMetadata(originalKey, label, durationSeconds, durationSource),
    };
  }

  const text = clampText(attempt.text.trim(), AUDIO_LIMITS.maxTextChars);
  if (text.truncated) {
    warnings.push({ code: "transcript_truncated", message: "The transcript was longer than what was kept." });
  }
  if (text.text === "") {
    warnings.push({ code: "no_speech", message: "No speech was detected in that recording." });
  }

  return {
    sourceType: "voice",
    status: "ready",
    extractedContent: text.text !== "" ? text.text : null,
    description: null,
    label,
    originalKey,
    thumbnailKey: null,
    url: null,
    mimeType,
    sizeBytes: file.bytes.length,
    error: null,
    warnings,
    metadata: {
      ...audioMetadata(originalKey, label, durationSeconds, durationSource),
      transcriptionProvider: attempt.provider,
    },
  };
}

function audioMetadata(
  originalKey: string,
  label: string,
  durationSeconds: number | null,
  durationSource: string | null
): Record<string, unknown> {
  return {
    storageKey: originalKey,
    originalFilename: label,
    ...(durationSeconds !== null ? { durationSeconds } : {}),
    ...(durationSource ? { durationSource } : {}),
    transcriptionStatus: "attempted",
  };
}

function failed(label: string, message: string, warnings: NormalizedIngestion["warnings"]): NormalizedIngestion {
  return {
    sourceType: "voice",
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
