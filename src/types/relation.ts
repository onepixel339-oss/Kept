/**
 * Shared relation types — the memory graph foundation.
 *
 * Endpoints are polymorphic: a relation connects memories to memories,
 * memories to entities, or entities to entities. The database stores
 * the (type, id) pairs without foreign keys; the application layer
 * validates existence and ownership on both ends. Phase 2 establishes
 * the data model and safe creation/reads — no graph traversal.
 */

/** What kind of node a relation endpoint points at. */
export const RELATION_NODE_TYPES = ["memory", "entity"] as const;

export type RelationNodeType = (typeof RELATION_NODE_TYPES)[number];

/** How two things in the graph relate. A small, controlled vocabulary. */
export const RELATION_TYPES = [
  "related_to",
  "involves",
  "about",
  "mentions",
  "follows",
  "caused_by",
  "contradicts",
  "replaces",
  "participates_in",
] as const;

export type RelationType = (typeof RELATION_TYPES)[number];

export const RELATION_STATUSES = ["active", "archived"] as const;

export type RelationStatus = (typeof RELATION_STATUSES)[number];

export interface Relation {
  id: string;
  userId: string;
  sourceType: RelationNodeType;
  sourceId: string;
  relationType: RelationType;
  targetType: RelationNodeType;
  targetId: string;
  confidence: number | null;
  status: RelationStatus;
  createdAt: Date;
  updatedAt: Date;
}

/** A relation resolved into named endpoints, for display and tests. */
export interface ResolvedRelation {
  relation: Relation;
  /** Human-readable label of the source endpoint. */
  sourceLabel: string | null;
  /** Human-readable label of the target endpoint. */
  targetLabel: string | null;
}
