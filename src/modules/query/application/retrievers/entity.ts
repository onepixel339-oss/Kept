/**
 * EntityRetriever — resolve who/what the question names, then find
 * the memories that involve them.
 *
 * Resolution is deterministic-first and ambiguity-preserving (the
 * Phase 3 ladder, reused through the entity module's public API):
 *
 *   exact → normalized → alias (transliteration) → partial
 *
 * AMBIGUITY RULE (spec §6): when one mention matches several equally
 * strong entities (two Ahmeds), they are NEVER silently combined.
 * Each candidate's memories are retrieved SEPARATELY — a memory is
 * tied to exactly one candidate entity — and the ambiguity is recorded
 * for the planner/UI to surface ("tell me which Ahmed").
 *
 * Scores by basis: exact 1.0, normalized 0.95, alias 0.75, partial
 * 0.5. Partial matches contribute only when the mention produced no
 * stronger evidence, and they are reported as a basis so the context
 * can stay honest about weak evidence.
 */

import {
  findEntityCandidatesByName,
  getEntity,
  listMemoryIdsForEntities,
  listRelationsTouchingNodes,
} from "@/modules/entity";
import { getMemoriesByIds } from "@/modules/memory";
import type { Entity } from "@/types/entity";
import type { RetrievalResult } from "@/types/query";
import type { Retriever, RetrievalInput, RetrievalOutput } from "../retrieval-types";
import { statusAllowed } from "../retrieval-types";

const BASIS_SCORE = { exact: 1, normalized: 0.95, alias: 0.75, partial: 0.5, ai: 0.8, scope: 1 } as const;

type ResolvedEntity = NonNullable<RetrievalOutput["entities"]>[number];
type AmbiguousMention = { entity: Entity; basis: "exact" | "normalized" | "alias" | "partial" };

export class EntityRetriever implements Retriever {
  readonly id = "entity" as const;

  async retrieve(input: RetrievalInput): Promise<RetrievalOutput> {
    if (input.step.kind !== "entity") return { results: [] };

    const output: RetrievalOutput = { results: [] };
    const resolvedEntities = new Map<string, ResolvedEntity>();

    // ——— Scope seeding (chat scopes §20): the focused entity/topic is
    //      a first-class seed. Ownership is verified by getEntity — a
    //      foreign or unknown scope id simply resolves to nothing. ———
    if (input.step.config.scopeEntityId) {
      const scopeEntity = await getEntity(input.userId, input.step.config.scopeEntityId).catch(() => null);
      if (scopeEntity) {
        await this.retrieveForCandidate(input, output, resolvedEntities, scopeEntity.name, scopeEntity, "scope");
      }
    }

    // ——— Resolve every mention and topic into candidate entities ———
    const groups: Array<{ key: string; candidates: AmbiguousMention[]; proposedEntityId: string | null }> = [];

    for (const mention of input.step.config.mentions) {
      const candidates = await findEntityCandidatesByName(input.userId, {
        type: mention.type,
        name: mention.mention,
        limit: 8,
      });
      this.pushGroup(groups, mention.mention, candidates, mention.entityId ?? null);
    }

    for (const topic of input.step.config.topics) {
      const candidates = await findEntityCandidatesByName(input.userId, {
        type: "topic",
        name: topic,
        limit: 8,
      });
      this.pushGroup(groups, topic, candidates, null);
    }

    // ——— Retrieve memories per candidate, separately ———
    for (const group of groups) {
      if (group.candidates.length === 0) {
        // LAST-RESORT bridge: deterministic matching found nothing, and
        // understanding PROPOSED a saved entity for this mention (a
        // validated id, cross-language references). The proposal is
        // re-verified against ownership here; it never overrides
        // deterministic evidence and never resolves an ambiguity.
        if (group.proposedEntityId) {
          const entity = await getEntity(input.userId, group.proposedEntityId).catch(() => null);
          if (entity) {
            await this.retrieveForCandidate(input, output, resolvedEntities, group.key, entity, "ai");
          }
        }
        continue;
      }

      const strongest = rankOf(group.candidates[0].basis);
      const sameStrength = group.candidates.filter((c) => rankOf(c.basis) === strongest);

      // Ambiguity: several equally strong candidates — never combined,
      // never resolved by the AI's proposal.
      if (sameStrength.length > 1 && strongest <= 1) {
        output.ambiguity = output.ambiguity ?? [];
        output.ambiguity.push({
          mention: group.key,
          candidates: sameStrength.map((c) => ({
            entityId: c.entity.id,
            name: c.entity.name,
            type: c.entity.type,
          })),
        });
      }

      for (const candidate of sameStrength) {
        // Weak (partial) evidence only when nothing stronger exists in
        // this group, and always flagged through its basis score.
        if (candidate.basis === "partial" && strongest <= 2) continue;
        await this.retrieveForCandidate(input, output, resolvedEntities, group.key, candidate.entity, candidate.basis);
      }
    }

    output.results = output.results
      .sort((a, b) => b.score - a.score)
      .slice(0, input.budget.maxResults);
    output.entities = [...resolvedEntities.values()];
    return output;
  }

  /** One candidate entity → its memories, with the basis score and provenance. */
  private async retrieveForCandidate(
    input: RetrievalInput,
    output: RetrievalOutput,
    resolvedEntities: Map<string, ResolvedEntity>,
    mentionKey: string,
    entity: Entity,
    basis: "exact" | "normalized" | "alias" | "partial" | "ai" | "scope"
  ): Promise<void> {
    const memoryIds = await this.memoryIdsForEntity(input.userId, entity.id);
    // The plan's status filter binds every retriever: superseded and
    // archived states stay out unless the plan widened to them.
    const rows = await getMemoriesByIds(input.userId, memoryIds);
    const score = BASIS_SCORE[basis];

    for (const row of rows) {
      if (!statusAllowed(input.filters, row.status)) continue;
      output.results.push({
        memoryId: row.id,
        source: this.id,
        score,
        matchedEntityIds: [entity.id],
        matchedTerms: [],
        reason:
          basis === "scope"
            ? `this conversation is about ${entity.name}`
            : `involves ${entity.name}`,
      });
    }

    if (memoryIds.length > 0 || basis !== "partial") {
      resolvedEntities.set(entity.id, {
        entityId: entity.id,
        name: entity.name,
        type: entity.type,
        basis,
        mention: mentionKey,
      });
    }

    // The resolved entity seeds graph traversal.
    input.seeds.entityIds.push(entity.id);
  }

  /** Memories tied to one entity: direct links plus memory↔entity relations. */
  private async memoryIdsForEntity(userId: string, entityId: string): Promise<string[]> {
    const linked = await listMemoryIdsForEntities(userId, [entityId]);
    const ids = new Set(linked.get(entityId) ?? []);

    const relations = await listRelationsTouchingNodes(userId, [{ type: "entity", id: entityId }], 20);
    for (const relation of relations) {
      if (relation.sourceType === "memory") ids.add(relation.sourceId);
      if (relation.targetType === "memory") ids.add(relation.targetId);
    }
    return [...ids];
  }

  private pushGroup(
    groups: Array<{ key: string; candidates: AmbiguousMention[]; proposedEntityId: string | null }>,
    key: string,
    candidates: Array<{ entity: Entity; basis: string }>,
    proposedEntityId: string | null
  ): void {
    const valid = candidates.filter(
      (candidate): candidate is AmbiguousMention =>
        candidate.basis === "exact" || candidate.basis === "normalized" || candidate.basis === "alias" || candidate.basis === "partial"
    );
    if (valid.length > 0 || proposedEntityId) {
      groups.push({ key, candidates: valid, proposedEntityId });
    }
  }
}

function rankOf(basis: "exact" | "normalized" | "alias" | "partial"): number {
  return basis === "exact" ? 0 : basis === "normalized" ? 1 : basis === "alias" ? 2 : 3;
}
