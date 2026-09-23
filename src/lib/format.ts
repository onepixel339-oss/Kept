/**
 * Presentation formatting — small, pure helpers for editorial UI.
 * Dates read like a journal, not a database.
 */

import { format } from "date-fns";

const DATE_FORMAT = "MMM d, yyyy";

export function formatDate(date: Date | null | undefined): string {
  if (!date) return "";
  return format(date, DATE_FORMAT);
}

/** A short excerpt of longer text, cut at a word boundary. */
export function snippet(text: string, length = 180): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= length) return clean;
  const cut = clean.slice(0, length);
  const lastSpace = cut.lastIndexOf(" ");
  return `${cut.slice(0, lastSpace > length * 0.6 ? lastSpace : length)}…`;
}
