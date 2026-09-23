/**
 * Entity resolution — deterministic-first, ambiguity-preserving.
 *
 * Order of evidence (each level only fires when the previous found
 * nothing usable):
 *
 *   1. exact canonical match          → reuse (deterministic)
 *   2. unique deep-normalized match   → reuse (deterministic)
 *   3. alias (transliteration) match  → reuse ONLY with proposer
 *                                       confidence ≥ entityAutoLink
 *   4. several equally-plausible
 *      candidates                     → AMBIGUOUS: link nothing, create
 *                                       nothing, record the ambiguity
 *   5. no candidates                  → create a new entity
 *
 * The invariant this module protects: a wrong link is worse than a
 * missing link, and a silent merge is the worst outcome of all. When
 * in doubt, the memory simply does not get that entity attached — the
 * user's text is still there, and the ambiguity is recorded for later
 * clarification.
 */

import type { Entity } from "@/types/entity";
import type { CandidateProposal } from "./ai-schemas";
import { intelligenceConfig } from "@/config/intelligence";

export interface ResolvedEntity {
  kind: "resolved";
  entity: Entity;
  /** Whether this run created the entity (provenance for the analysis record). */
  created: boolean;
  basis: "exact" | "normalized" | "alias" | "new";
  confidence: number;
}

export interface AmbiguousEntity {
  kind: "ambiguous";
  proposedName: string;
  proposedType: string;
  candidateEntityIds: string[];
  confidence: number;
}

export type EntityResolution = ResolvedEntity | AmbiguousEntity;

/** Minimal surface of the entity module this layer depends on. */
export interface EntityResolutionDeps {
  findEntityCandidatesByName(
    userId: string,
    input: { type: Entity["type"]; name: string; limit?: number }
  ): Promise<Array<{ entity: Entity; basis: "exact" | "normalized" | "alias" | "partial" }>>;
  createEntity(
    userId: string,
    input: { type: Entity["type"]; name: string }
  ): Promise<{ entity: Entity; reused: boolean }>;
}

/**
 * Resolve one proposed entity for one user. Deterministic matches are
 * trusted on their own evidence; fuzzy matches additionally require
 * the proposer to clear the entityAutoLink gate. Partial matches are
 * NEVER auto-applied — they participate only in ambiguity detection
 * (e.g. "Ahmed" against "Ahmed — school" and "Ahmed — university").
 */
export async function resolveEntity(
  userId: string,
  proposal: CandidateProposal["entities"][number],
  deps: EntityResolutionDeps
): Promise<EntityResolution> {
  const candidates = await deps.findEntityCandidatesByName(userId, {
    type: proposal.type,
    name: proposal.name,
    limit: intelligenceConfig.limits.maxCandidateEntitiesPerType,
  });

  const exact = candidates.filter((c) => c.basis === "exact");
  if (exact.length >= 1) {
    // The unique constraint guarantees one exact canonical match per
    // (user, type); take it and ignore anything fuzzier.
    return {
      kind: "resolved",
      entity: exact[0].entity,
      created: false,
      basis: "exact",
      confidence: 1,
    };
  }

  const normalized = candidates.filter((c) => c.basis === "normalized");
  if (normalized.length === 1) {
    return {
      kind: "resolved",
      entity: normalized[0].entity,
      created: false,
      basis: "normalized",
      confidence: proposal.confidence,
    };
  }

  const alias = candidates.filter((c) => c.basis === "alias");
  if (alias.length === 1 && proposal.confidence >= intelligenceConfig.thresholds.entityAutoLink) {
    return {
      kind: "resolved",
      entity: alias[0].entity,
      created: false,
      basis: "alias",
      confidence: proposal.confidence,
    };
  }

  // Ambiguity: any combination of multiple normalized/alias candidates,
  // or multiple partial candidates ("Ahmed" vs "Ahmed — school" and
  // "Ahmed — university"), or a lone PARTIAL match (containment alone
  // is never enough evidence to attach a memory to an entity).
  const strong = [...normalized, ...alias];
  const partial = candidates.filter((c) => c.basis === "partial");

  if (strong.length > 1 || (strong.length === 0 && partial.length > 0)) {
    const pool = strong.length > 0 ? strong : partial;
    return {
      kind: "ambiguous",
      proposedName: proposal.name,
      proposedType: proposal.type,
      candidateEntityIds: pool.map((c) => c.entity.id),
      confidence: proposal.confidence,
    };
  }

  if (strong.length === 1) {
    // A single alias candidate that failed the confidence gate: linking
    // would be a guess. Record as ambiguous rather than guessing.
    if (strong[0].basis === "alias") {
      return {
        kind: "ambiguous",
        proposedName: proposal.name,
        proposedType: proposal.type,
        candidateEntityIds: [strong[0].entity.id],
        confidence: proposal.confidence,
      };
    }
    return {
      kind: "resolved",
      entity: strong[0].entity,
      created: false,
      basis: strong[0].basis as "normalized",
      confidence: proposal.confidence,
    };
  }

  // No usable candidate: create. Creation is cheap, reversible, and
  // never destroys anything — the conservative default for new names.
  const { entity } = await deps.createEntity(userId, {
    type: proposal.type,
    name: proposal.name,
  });
  return {
    kind: "resolved",
    entity,
    created: true,
    basis: "new",
    confidence: proposal.confidence,
  };
}

/** Resolve every proposed entity of a candidate, in order, bounded. */
export async function resolveCandidateEntities(
  userId: string,
  candidate: CandidateProposal,
  deps: EntityResolutionDeps
): Promise<EntityResolution[]> {
  const resolutions: EntityResolution[] = [];
  for (const proposal of candidate.entities) {
    resolutions.push(await resolveEntity(userId, proposal, deps));
  }
  return resolutions;
}
