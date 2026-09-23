/**
 * AI ingestion contracts — the Phase 9 seam for rich input extraction.
 *
 * Same law as every other AI contract: providers return raw output and
 * never see the database; the ingestion module owns validation. A
 * vision "proposal" is untrusted text until the ingestion domain
 * schema accepts it; a transcript is raw text that must survive the
 * same bounded checks every extraction result passes.
 *
 * Capabilities are declared honestly and verified against the real
 * SDK surface (Phase 9 probes): the installed z.ai provider DOES
 * expose vision (chat.completions.createVision — verified extracting
 * printed text from an image) and DOES expose ASR (audio.asr.create —
 * verified returning a text transcript). Both flags are true, and
 * both implementations are real — no invented endpoints.
 */

import type { ProviderResult } from "./intelligence-types";

/** Extract readable content from a user-owned image (OCR-style, factual). */
export interface ExtractImageRequest {
  /** The image bytes, base64. Only validated, size-bounded uploads reach here. */
  imageBase64: string;
  /** The validated MIME type (content signature checked upstream). */
  mimeType: string;
}

/**
 * Transcribe a user-owned audio recording. The original audio is
 * always preserved separately (spec §7) — the transcript is a second
 * representation, never a replacement.
 */
export interface TranscribeRequest {
  /** The audio bytes, base64. */
  audioBase64: string;
  /** The validated MIME type. */
  mimeType: string;
}

/** The honest result of a vision extraction attempt. */
export type ImageExtractionResult =
  | ({ available: true } & ProviderResult)
  | { available: false; reason: string };

/** The honest result of a transcription attempt. */
export type TranscriptionResult =
  | { available: true; text: string; provider: string }
  | { available: false; reason: string };
