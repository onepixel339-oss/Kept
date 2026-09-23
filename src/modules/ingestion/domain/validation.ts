/**
 * Upload validation (Phase 9 §6, §13) — never trust what the client
 * claims. Filenames are display labels, not paths; MIME types are
 * hints to be confirmed against content signatures; everything is
 * size-capped before it is read.
 */

import { MAX_IMAGE_BYTES } from "@/config/ingestion";

/** An uploaded file, decoded from multipart by the route. */
export interface UploadFile {
  name: string;
  mimeType: string;
  bytes: Buffer;
}

/**
 * A display-safe version of the client's filename: basename only,
 * control characters stripped, bounded. NEVER used to build a storage
 * path — storage keys are generated server-side (lib/storage).
 */
export function safeDisplayName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return cleaned.slice(0, 180);
}

/** Lowercase extension including the dot, or "". */
export function fileExtension(name: string): string {
  const base = safeDisplayName(name);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot).toLowerCase();
}

/* ——— Content signatures (magic bytes) ——— */

export type ImageKind = "png" | "jpeg" | "webp" | "gif";

export function detectImageKind(bytes: Buffer): ImageKind | null {
  if (bytes.length < 12) return null;
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  if (bytes.subarray(0, 6).toString("latin1") === "GIF87a" || bytes.subarray(0, 6).toString("latin1") === "GIF89a") return "gif";
  return null;
}

export type AudioKind = "wav" | "mp3" | "mp4" | "webm" | "ogg";

export function detectAudioKind(bytes: Buffer): AudioKind | null {
  if (bytes.length < 12) return null;
  if (bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WAVE") return "wav";
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return "mp3"; // ID3
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return "mp3"; // MPEG frame sync
  if (bytes.subarray(4, 8).toString("latin1") === "ftyp") return "mp4"; // mp4/m4a family
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "webm";
  if (bytes.subarray(0, 4).toString("latin1") === "OggS") return "ogg";
  return null;
}

export type DocumentKind = "txt" | "md" | "pdf" | "docx";

/**
 * Decide what kind of document this really is. Extension and signature
 * must AGREE for pdf/docx; text documents are accepted when the bytes
 * decode as text regardless of a missing extension claim.
 */
export function detectDocumentKind(bytes: Buffer, extension: string): DocumentKind | null {
  if (bytes.length === 0) return null;

  // PDF: signature within the first kilobyte.
  if (bytes.subarray(0, 1024).includes(Buffer.from("%PDF-"))) {
    return extension === ".pdf" || extension === "" ? "pdf" : null;
  }
  // ZIP container (docx) — confirmed by finding word/document.xml later.
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07)) {
    return extension === ".docx" || extension === "" ? "docx" : null;
  }
  // Text documents: decodable UTF-8 with (almost) no control noise.
  if (extension === ".txt" || extension === ".md" || extension === ".markdown" || extension === "") {
    const sample = bytes.subarray(0, 4096);
    const decoded = sample.toString("utf8");
    const controlNoise = decoded.split("").filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code < 9 || (code > 13 && code < 32) || code === 0xfffd;
    }).length;
    if (controlNoise / Math.max(1, decoded.length) < 0.02) {
      return extension === ".md" || extension === ".markdown" ? "md" : "txt";
    }
  }
  return null;
}

/** Canonical MIME stored for an image kind. */
export function imageMime(kind: ImageKind): string {
  switch (kind) {
    case "png":
      return "image/png";
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
  }
}

/** Canonical MIME stored for an audio kind. */
export function audioMime(kind: AudioKind): string {
  switch (kind) {
    case "wav":
      return "audio/wav";
    case "mp3":
      return "audio/mpeg";
    case "mp4":
      return "audio/mp4";
    case "webm":
      return "audio/webm";
    case "ogg":
      return "audio/ogg";
  }
}

/** File extension for a canonical image/audio MIME (storage key suffix). */
export function extensionForMime(mime: string): string {
  switch (mime) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "audio/wav":
      return "wav";
    case "audio/mpeg":
      return "mp3";
    case "audio/mp4":
      return "m4a";
    case "audio/webm":
      return "webm";
    case "audio/ogg":
      return "ogg";
    default:
      return "bin";
  }
}

/** Shared opening check for every upload: non-empty and within cap. */
export function assertUploadSize(bytes: Buffer, maxBytes: number): void {
  if (bytes.length === 0) {
    throw new SizeError("That file is empty.");
  }
  if (bytes.length > maxBytes) {
    throw new SizeError(`That file is larger than the ${Math.floor(maxBytes / (1024 * 1024))} MB limit.`);
  }
}

/** Distinct error type so the route can map it to a clean 400. */
export class SizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SizeError";
  }
}

/** Sanity: images must stay under the image cap by definition. */
export const IMAGE_SIZE_LIMIT = MAX_IMAGE_BYTES;
