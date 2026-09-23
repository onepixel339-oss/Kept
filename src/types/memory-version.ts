/**
 * Shared version types — a memory's append-only history.
 *
 * Versioning rules (see docs/memory-system.md):
 *  - v1 is written when the memory is created (changeType "created").
 *  - Each meaningful edit to originalContent, title, or summary
 *    appends the next version (changeType "edited").
 *  - Versions are never rewritten. They live and die with their memory.
 *  - The current memory row is the current state; versions are the
 *    states that came before.
 */

export type VersionChangeType = "created" | "edited";

export interface MemoryVersion {
  id: string;
  memoryId: string;
  versionNumber: number;
  /** The memory's content at this point in history. */
  originalContent: string;
  title: string | null;
  summary: string | null;
  changeType: VersionChangeType;
  /** Reserved for future explanations (user notes, AI proposals). Null today. */
  changeReason: string | null;
  createdAt: Date;
}
