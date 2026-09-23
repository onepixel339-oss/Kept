/**
 * Memory domain rules — pure functions, no database, no framework.
 *
 * This is where "meaningful" is defined, titles are derived without
 * magic, and the module's vocabulary constants live for internal use.
 * Everything here is deterministic and unit-testable by design.
 */

import { DEFAULT_MEMORY_TYPE, type MemoryStatus, type MemoryType } from "@/types/memory";

/** The textual substance of a memory — the only fields that version. */
export interface TextualState {
  originalContent: string;
  title: string | null;
  summary: string | null;
}

const TITLE_MAX_LENGTH = 60;

/**
 * Derive a deterministic title from the user's own words: the first
 * sentence when it is short enough, otherwise the first clause cut at
 * a word boundary. No AI, no randomness — the same words always
 * produce the same title.
 */
export function deriveTitle(content: string, maxLength = TITLE_MAX_LENGTH): string {
  const clean = content.replace(/\s+/g, " ").trim();
  if (!clean) return "";

  const sentenceEnd = clean.search(/[.!?…](\s|$)/);
  if (sentenceEnd !== -1) {
    const sentence = clean.slice(0, sentenceEnd + 1);
    if (sentence.length <= maxLength) return sentence;
  }

  if (clean.length <= maxLength) return clean;

  const cut = clean.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(" ");
  return `${cut.slice(0, lastSpace > maxLength * 0.5 ? lastSpace : maxLength)}…`;
}

function normalize(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

/**
 * Whether an edit changes a memory's textual substance
 * (originalContent, title, or summary). Only meaningful edits create
 * versions; metadata tweaks (type, importance, dates, status) update
 * in place.
 */
export function isMeaningfulChange(before: TextualState, after: TextualState): boolean {
  return (
    before.originalContent !== after.originalContent ||
    normalize(before.title) !== normalize(after.title) ||
    normalize(before.summary) !== normalize(after.summary)
  );
}

/** Statuses a memory may move between. Kept explicit, not inferred. */
export const MEMORY_STATUS_VALUES: readonly MemoryStatus[] = ["active", "archived", "superseded"];

/** Types a memory may take. Kept explicit, not inferred. */
export const MEMORY_TYPE_VALUES: readonly MemoryType[] = [
  "experience",
  "fact",
  "thought",
  "event",
  "idea",
  "note",
  "conversation",
];

export { DEFAULT_MEMORY_TYPE };
