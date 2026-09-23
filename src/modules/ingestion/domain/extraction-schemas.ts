/**
 * Extraction proposal schemas (Phase 9) — the ingestion module's
 * validation layer for AI output, mirroring the intelligence module's
 * pattern: the provider returns raw text; only what survives zod
 * reaches a source row or a memory.
 */

import { z } from "zod";
import { IMAGE_LIMITS } from "@/config/ingestion";
import { clampText } from "./ingestion-types";

/**
 * The vision proposal: verbatim readable text + one factual sentence.
 * Both fields may be empty (a photo of a place has no text); neither
 * may be missing.
 */
export const imageExtractionSchema = z.object({
  text: z.string().max(IMAGE_LIMITS.maxTextChars * 2),
  description: z.string().max(1_000),
});

export type ImageExtractionProposal = z.infer<typeof imageExtractionSchema>;

/** Parse a raw vision response. Returns null when it is not acceptable. */
export function parseImageExtraction(raw: string): ImageExtractionProposal | null {
  // Tolerate markdown fences around the JSON — models add them even
  // when told not to; the content itself is what matters.
  const stripped = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let candidate: unknown;
  try {
    candidate = JSON.parse(stripped);
  } catch {
    return null;
  }
  const parsed = imageExtractionSchema.safeParse(candidate);
  if (!parsed.success) return null;

  const text = clampText(parsed.data.text.trim(), IMAGE_LIMITS.maxTextChars);
  const description = parsed.data.description.trim().slice(0, 600);
  return { text: text.text, description };
}
