/**
 * Shared entity types — the people, places, and things inside memories.
 *
 * Reuse rule (Phase 2, pre-AI): an exact (user, type, canonicalName)
 * match is reused; anything ambiguous is never silently merged.
 * Intelligent resolution arrives in a later phase through the AI
 * gateway — as a proposal, never an autonomous merge.
 */

export const ENTITY_TYPES = [
  "person",
  "place",
  "organization",
  "project",
  "topic",
  "object",
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];

/** The role an entity plays in a memory. */
export const ENTITY_ROLES = [
  "participant",
  "subject",
  "location",
  "topic",
  "mentioned",
  "object",
] as const;

export type EntityRole = (typeof ENTITY_ROLES)[number];

/** Default role when nothing better is known. */
export const DEFAULT_ENTITY_ROLE: EntityRole = "mentioned";

export interface Entity {
  id: string;
  userId: string;
  type: EntityType;
  /** The name as given. */
  name: string;
  /** Normalized name for exact matching (trimmed, lowercased, whitespace-collapsed). */
  canonicalName: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** An explicit memory ↔ entity link. */
export interface MemoryEntityLink {
  memoryId: string;
  entityId: string;
  role: EntityRole;
  confidence: number | null;
}
