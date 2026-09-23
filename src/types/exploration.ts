/**
 * Shared exploration types — the view models the People / Topics /
 * Timeline surfaces render.
 *
 * Everything here is DERIVED from stored data (entities, links,
 * relations, memory rows) by deterministic database queries. Nothing
 * is generated: counts are database aggregates, dates are dates the
 * memories actually carry, and "last kept" is a kept-date, clearly a
 * kept-date — never a fabricated event date.
 */

import type { Entity } from "./entity";
import type { MemoryStatus, MemoryType } from "./memory";
import type { ProcessingStatus } from "./processing";
import type { ResolvedRelation } from "./relation";

/** One page of memories as the exploration lists show them. */
export interface EntityMemoryPage {
  items: Array<{
    id: string;
    title: string | null;
    snippet: string;
    memoryType: MemoryType;
    /** Real lifecycle/processing state — the UI never fakes "ready". */
    status: MemoryStatus;
    processingStatus: ProcessingStatus;
    rememberedAt: Date | null;
    createdAt: Date;
  }>;
  page: number;
  pageSize: number;
  total: number;
}

/**
 * A person or topic as the exploration lists show it: quiet facts
 * only. `relatedTopics` / `relatedPeople` are derived from shared
 * appearance in recent memories (bounded) — descriptive, not ranked.
 */
export interface EntitySummary {
  entity: Entity;
  memoryCount: number;
  lastKeptAt: Date | null;
  relatedTopics: Array<{ id: string; name: string }>;
  relatedPeople: Array<{ id: string; name: string }>;
}

/**
 * One entry on a timeline: a memory with a KNOWN event date. The
 * date shown is the memory's own `rememberedAt` — never a proxy.
 */
export interface TimelineEntry {
  memoryId: string;
  title: string | null;
  snippet: string;
  memoryType: string;
  date: Date;
}

export interface TimelineMonth {
  /** "2025-03" — stable key. */
  key: string;
  label: string;
  entries: TimelineEntry[];
}

export interface TimelineYear {
  year: number;
  months: TimelineMonth[];
}

/** Everything the person/topic detail page renders, already bounded. */
export interface EntityDetailData {
  entity: Entity;
  memoryCount: number;
  lastKeptAt: Date | null;
  memories: EntityMemoryPage;
  topics: Array<{ id: string; name: string; memoryCount: number }>;
  people: Array<{ id: string; name: string; memoryCount: number }>;
  timeline: TimelineYear[];
  /** True when the timeline was cut off at its bound (older entries exist). */
  timelineTruncated: boolean;
  /** Explicit graph edges touching this entity, endpoints resolved. */
  connections: ResolvedRelation[];
}

/**
 * A "more like this" neighbor: found through shared saved things —
 * shared entities are named, so the suggestion is always explainable.
 */
export interface SimilarMemory {
  memoryId: string;
  title: string | null;
  snippet: string;
  memoryType: string;
  createdAt: Date;
  shared: Array<{ id: string; name: string }>;
}

/** The quiet discovery strip: who and what appear in the user's memories. */
export interface DiscoveryData {
  people: Array<{ id: string; name: string; memoryCount: number }>;
  topics: Array<{ id: string; name: string; memoryCount: number }>;
}
