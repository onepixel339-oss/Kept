/**
 * Ingestion configuration — the documented limits of rich input.
 *
 * Every number here is a deliberate, reviewable default (spec §31):
 * generous enough for real personal archives, tight enough that no
 * single upload can exhaust memory or time. Extraction is bounded:
 * bounded size in, bounded text out, bounded time for every external
 * call. Changing a limit is a one-line edit and a docs update.
 */

/** Max upload sizes, in bytes. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB — photos, screenshots
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // 25 MB — ~25 min of WAV mono 16kHz speech
export const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB — documents
export const MAX_TEXT_BYTES = 512 * 1024; // 512 KB of typed/pasted text

/** URL ingestion (spec §14–16). */
export const URL_LIMITS = {
  /** Only these schemes are ever fetched. */
  protocols: ["http:", "https:"] as const,
  /** Only these ports pass validation. */
  ports: [80, 443],
  /** Bounded redirects; every hop is re-validated (spec §15). */
  maxRedirects: 3,
  /** Per-request timeout, ms. */
  timeoutMs: 10_000,
  /** Largest response body read, bytes. */
  maxResponseBytes: 5 * 1024 * 1024,
  /** Largest readable text kept after HTML→text, characters. */
  maxTextChars: 20_000,
} as const;

/** Image extraction. */
export const IMAGE_LIMITS = {
  /** Thumbnail long edge, px. */
  thumbnailEdge: 512,
  /** Largest extracted text kept from an image, characters. */
  maxTextChars: 8_000,
  /** Vision call timeout, ms. */
  visionTimeoutMs: 30_000,
} as const;

/** Audio extraction. */
export const AUDIO_LIMITS = {
  /** Largest transcript kept, characters. */
  maxTextChars: 20_000,
  /** Transcription call timeout, ms. */
  transcribeTimeoutMs: 60_000,
} as const;

/** Document extraction. */
export const DOCUMENT_LIMITS = {
  /** Largest extracted text kept, characters. */
  maxTextChars: 50_000,
  /** Extraction work timeout, ms. */
  extractionTimeoutMs: 20_000,
} as const;

/**
 * Accepted upload types. Validation NEVER trusts the client-declared
 * MIME or extension alone (spec §13): content signatures are checked
 * in the extractors; these tables gate what is even attempted.
 */
export const ACCEPTED_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

export const ACCEPTED_AUDIO_TYPES = [
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/mpeg",
  "audio/mp4",
  "audio/x-m4a",
  "audio/webm",
  "audio/ogg",
] as const;

export const ACCEPTED_DOCUMENT_EXTENSIONS = [
  ".txt",
  ".md",
  ".markdown",
  ".pdf",
  ".docx",
] as const;

/** Text document MIME types accepted for extraction. */
export const TEXT_DOCUMENT_TYPES = ["text/plain", "text/markdown"] as const;

/** Local storage root override (tests point this at a temp directory). */
export const STORAGE_ROOT_ENV = "INGESTION_STORAGE_ROOT";

/** Supabase Storage bucket override (default: kept-uploads, private). */
export const STORAGE_BUCKET_ENV = "KEPT_SUPABASE_BUCKET";
