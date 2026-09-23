/**
 * Shared memory domain types — the project's ubiquitous language.
 *
 * These types are the single source of truth for what a Memory IS.
 * The Prisma model mirrors them; UI, API, and modules all speak this
 * language. Any change here is a domain decision, not a refactor.
 *
 * Enum values are stored as plain strings and validated at the
 * application boundary (never in the database). The database stores;
 * the application decides.
 */

import type { EmbeddingStatus, ProcessingStatus } from "@/types/processing";

/** What kind of thing was remembered. A small, controlled vocabulary. */
export const MEMORY_TYPES = [
  "experience",
  "fact",
  "thought",
  "event",
  "idea",
  "note",
  "conversation",
] as const;

export type MemoryType = (typeof MEMORY_TYPES)[number];

/** The neutral default until real understanding exists. */
export const DEFAULT_MEMORY_TYPE: MemoryType = "note";

/** Lifecycle status. Deletion is a real removal (see deleteMemory); these are retention states. */
export const MEMORY_STATUSES = ["active", "archived", "superseded"] as const;

export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

/**
 * How significant this memory is, from 0 (trivial) to 1 (defining).
 * A proposal — the user always has the final say in the UI.
 */
export type MemoryImportance = number;

/**
 * How certain the system is about its understanding of this memory,
 * from 0 (guess) to 1 (certain). Null until real understanding exists —
 * Phase 2 never fabricates certainty.
 */
export type MemoryConfidence = number;

/**
 * A Memory — one thing the user chose to keep.
 *
 * Invariants:
 *  - `originalContent` is exactly what the user wrote. It is preserved
 *    verbatim, forever, and is never replaced by a summary or any
 *    generated text. Edits create versions; they never erase history.
 *  - Everything except `originalContent` is understanding that can be
 *    revised (by the user now, by validated AI proposals in the
 *    intelligence pipeline).
 *  - `processingStatus` tracks the system's understanding of the
 *    memory, never its validity: failed processing never loses content.
 *  - Every memory is scoped to exactly one user. Always.
 */
export interface Memory {
  id: string;
  /** Owner. Every memory belongs to exactly one user. */
  userId: string;
  /** A short, human title. Deterministically derived at creation; user-editable. */
  title: string | null;
  /** The user's own words. Never replaced by generated text. */
  originalContent: string;
  /** A concise restatement. Null until real understanding exists. */
  summary: string | null;
  memoryType: MemoryType;
  importance: MemoryImportance;
  confidence: MemoryConfidence | null;
  status: MemoryStatus;
  /**
   * When the remembered thing happened (as the user experienced it),
   * which may differ from when it was written down. Null when unknown.
   */
  rememberedAt: Date | null;
  /** Intelligence pipeline state — independent of lifecycle status. */
  processingStatus: ProcessingStatus;
  /** Stable, human-safe reason when processing failed. Never raw internals. */
  processingError: string | null;
  /** When processing last completed (successfully). */
  processedAt: Date | null;
  /** Semantic embedding state. "deferred" in this environment — see docs. */
  embeddingStatus: EmbeddingStatus;
  createdAt: Date;
  updatedAt: Date;
}

/** Input for creating a memory — only what the user actually provides. */
export interface MemoryDraft {
  originalContent: string;
  title?: string | null;
  memoryType?: MemoryType;
  importance?: number;
  rememberedAt?: Date | null;
}

/** A light projection of a memory for lists (home, memories page). */
export interface MemoryListItem {
  id: string;
  title: string | null;
  /** Short excerpt of the original content for editorial lists. */
  snippet: string;
  memoryType: MemoryType;
  status: MemoryStatus;
  /** Shown as a quiet micro-state in lists until processing completes. */
  processingStatus: ProcessingStatus;
  rememberedAt: Date | null;
  createdAt: Date;
}

/** Result page for list queries. */
export interface MemoryListResult {
  items: MemoryListItem[];
  page: number;
  pageSize: number;
  total: number;
}
