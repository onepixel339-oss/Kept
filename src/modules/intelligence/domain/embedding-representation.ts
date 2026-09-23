/**
 * The canonical semantic representation of a memory (Phase 8 §2).
 *
 * An embedding must capture what a memory MEANS — not blindly embed
 * every raw field. The representation is deterministic, versioned, and
 * derived: it never replaces the memory's own text, is never written
 * back into any memory field, and the version constant below is part
 * of every embedding's stored identity so a future representation
 * change invalidates old vectors BY CONSTRUCTION (they become stale —
 * regenerable, never silently current).
 *
 * Representation v1 (documented in docs/semantic-memory.md):
 *   line 1  the AI/user title, when one exists
 *   line 2  the summary, when one exists — otherwise the user's own
 *           original content (the meaning must come from somewhere
 *           real; a memory with no summary still embeds its words)
 *   line 3  the linked entity names (the people/places/topics the
 *           memory is about)
 *
 * The text is bounded: embedding inputs have token limits, and an
 * honest truncation at a documented boundary beats a silent provider
 * error. Truncation happens on whole lines where possible.
 */

import type { Memory } from "@/types/memory";

/** Bumped whenever the representation rule changes — old vectors then read as stale. */
export const EMBEDDING_REPRESENTATION_VERSION = "v1";

/** Hard upper bound on the embedded text, in characters. */
const MAX_EMBEDDING_TEXT_LENGTH = 2000;

export interface EmbeddingRepresentationInput {
  title: string | null;
  summary: string | null;
  /** The user's own words, verbatim — used only when no summary exists. */
  originalContent: string;
  /** Names of the entities linked to this memory (people, places, topics…). */
  entityNames: string[];
}

/** Build the canonical representation from a memory row plus its linked entity names. */
export function representationFromMemory(
  memory: Memory,
  entityNames: string[]
): EmbeddingRepresentationInput {
  return {
    title: memory.title,
    summary: memory.summary,
    originalContent: memory.originalContent,
    entityNames,
  };
}

export function buildEmbeddingText(input: EmbeddingRepresentationInput): string {
  const lines: string[] = [];

  const title = input.title?.trim();
  if (title) lines.push(title);

  const summary = input.summary?.trim();
  if (summary) {
    lines.push(summary);
  } else {
    const content = input.originalContent.trim();
    if (content) lines.push(content);
  }

  const entities = input.entityNames
    .map((name) => name.trim())
    .filter((name) => name !== "");
  if (entities.length > 0) lines.push(entities.join(", "));

  const text = lines.join("\n");
  if (text.length <= MAX_EMBEDDING_TEXT_LENGTH) return text;

  // Truncate at the last whole line that fits; a single over-long line
  // is cut hard. Either way the bound is honest and documented.
  let fitting = text.slice(0, MAX_EMBEDDING_TEXT_LENGTH);
  const lastBreak = fitting.lastIndexOf("\n");
  if (lastBreak > MAX_EMBEDDING_TEXT_LENGTH / 2) {
    fitting = fitting.slice(0, lastBreak);
  }
  return fitting.trimEnd();
}
