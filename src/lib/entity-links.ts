/**
 * Entity → route mapping — the one place that decides where a saved
 * thing opens.
 *
 * People have person pages; topics and projects have topic pages;
 * everything else (places, organizations, objects) opens its scoped
 * view in Search, which already shows everything kept involving it.
 * No duplicate surfaces for the same entity.
 */

import type { Entity, EntityType } from "@/types/entity";

/** Entity types the Topics surfaces cover (spec §4: topics + projects). */
export const TOPIC_ENTITY_TYPES: EntityType[] = ["topic", "project"];

export const PERSON_ENTITY_TYPES: EntityType[] = ["person"];

export function isTopicEntity(type: EntityType): boolean {
  return TOPIC_ENTITY_TYPES.includes(type);
}

export function isPersonEntity(type: EntityType): boolean {
  return type === "person";
}

/**
 * Where clicking this entity should lead. Entities without a
 * dedicated page fall back to their search-scoped view — a real
 * destination, never a dead link.
 */
export function entityHref(entity: Pick<Entity, "id" | "type"> & { type: EntityType }): string {
  if (isPersonEntity(entity.type)) return `/people/${entity.id}`;
  if (isTopicEntity(entity.type)) return `/topics/${entity.id}`;
  return `/search?entity=${entity.id}`;
}

/** Type-narrowing wrapper for values read from the database as strings. */
export function entityHrefFromParts(id: string, type: string): string {
  return entityHref({ id, type: type as EntityType });
}