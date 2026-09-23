/**
 * Memory content composition (Phase 9 §19–20) — how a memory's words
 * are chosen from what ingestion gathered.
 *
 * Rules:
 *  - The user's own typed words (caption/note) come first, verbatim.
 *  - Extracted content (OCR, transcript, document text, page text) is
 *    the user's own content read back from their own source — kept
 *    verbatim, clearly a second part when both exist.
 *  - A machine description is used ONLY when nothing else exists, and
 *    is marked as machine-written in the metadata (never silently
 *    presented as the user's words).
 *  - Nothing composed here is ever a summary or generated prose.
 */

import type { ContentOrigin } from "@/types/source";
import type { SourceContribution } from "./ingestion-types";

export interface ComposedContent {
  content: string | null;
  origin: ContentOrigin | null;
}

export function composeMemoryContent(contributions: SourceContribution[]): ComposedContent {
  const userText = contributions
    .filter((c) => c.origin === "user_text" && c.text && c.text.trim() !== "")
    .map((c) => c.text!.trim())
    .join("\n\n");
  const extracted = contributions
    .filter((c) => c.origin === "extracted" && c.text && c.text.trim() !== "")
    .map((c) => c.text!.trim())
    .join("\n\n");
  const machine = contributions
    .filter((c) => c.origin === "machine_description" && c.text && c.text.trim() !== "")
    .map((c) => c.text!.trim())
    .join("\n\n");

  if (userText !== "" && extracted !== "") {
    return { content: `${userText}\n\n${extracted}`, origin: "user_text_plus_extracted" };
  }
  if (userText !== "") {
    return { content: userText, origin: "user_text" };
  }
  if (extracted !== "") {
    return { content: extracted, origin: "extracted" };
  }
  if (machine !== "") {
    return { content: machine, origin: "machine_description" };
  }
  return { content: null, origin: null };
}
