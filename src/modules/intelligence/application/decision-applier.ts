/**
 * Decision applier — the ONLY place approved intelligence changes
 * become writes.
 *
 * The AI proposed; the decision engine decided; this module applies —
 * exclusively through the memory and entity modules' public APIs, so
 * every ownership check, version rule, and graph guard those modules
 * enforce still applies. The AI itself never writes anything, anywhere,
 * ever.
 *
 * Everything here is idempotent: retries re-run the pipeline and must
 * not duplicate memories, versions, relations, or links.
 */

import {
  applyMemoryEnrichment,
  applyMemoryStateUpdate,
  deriveTitle,
  findMemory,
  updateMemory,
  type AiEnrichment,
} from "@/modules/memory";
import {
  createRelation,
  linkMemoryEntity,
  relationExists,
} from "@/modules/entity";
import type { Memory } from "@/types/memory";
import type { Decision } from "../domain/decision-engine";
import type { CandidateProposal } from "../domain/ai-schemas";
import type { EntityResolution } from "../domain/entity-resolution";
import { intelligenceConfig } from "@/config/intelligence";

/** One resolution result, carrying the proposal that produced it. */
export type ResolutionWithProposal = EntityResolution & {
  proposal: CandidateProposal["entities"][number];
};

export interface AppliedChanges {
  enriched: boolean;
  entitiesLinked: string[]; // entity names linked to the incoming memory
  entitiesLinkedToTarget: string[]; // entity names also linked to an update/merge target
  ambiguousEntities: Array<{ name: string; type: string; candidateEntityIds: string[] }>;
  relationsCreated: string[]; // human-readable, for the provenance record
  versionAppended: boolean;
  supersededIncoming: boolean;
}

/** The enrichment patch the guard rules allow onto the incoming memory. */
function allowedEnrichment(memory: Memory, candidate: CandidateProposal): AiEnrichment {
  const patch: AiEnrichment = {
    confidence: candidate.confidence,
  };

  // Title: only replace mechanical/absent titles — a title the user
  // chose is theirs. (A deterministic title is recognizable because it
  // is exactly what deriveTitle would produce today.)
  const derived = deriveTitle(memory.originalContent) || null;
  if (candidate.title && (memory.title === null || memory.title === derived)) {
    patch.title = candidate.title;
  }

  // Summary: only when the user has not written one.
  if (candidate.summary && (memory.summary === null || memory.summary.trim() === "")) {
    patch.summary = candidate.summary;
  }

  // Type: only upgrade away from the neutral default.
  if (memory.memoryType === "note" && candidate.type !== "note") {
    patch.memoryType = candidate.type;
  }

  // Remembered date: only when absent, certain enough, and parseable.
  // "Maybe 2024" must stay uncertain — the timeApply gate exists for it.
  if (
    memory.rememberedAt === null &&
    candidate.time.normalized &&
    candidate.time.confidence >= intelligenceConfig.thresholds.timeApply
  ) {
    const date = parseProposedDate(candidate.time.normalized);
    if (date) patch.rememberedAt = date;
  }

  return patch;
}

/** Accept "YYYY-MM-DD" (treated as noon UTC) or a full ISO timestamp. */
function parseProposedDate(value: string): Date | null {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dateOnly) {
    const date = new Date(`${value}T12:00:00.000Z`);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

async function linkResolutions(
  userId: string,
  memoryId: string,
  resolutions: ResolutionWithProposal[],
  applied: AppliedChanges
): Promise<void> {
  for (const resolution of resolutions) {
    if (resolution.kind !== "resolved") {
      applied.ambiguousEntities.push({
        name: resolution.proposedName,
        type: resolution.proposedType,
        candidateEntityIds: resolution.candidateEntityIds,
      });
      continue;
    }
    await linkMemoryEntity(userId, memoryId, resolution.entity.id, {
      role: resolution.proposal.role,
      confidence: resolution.proposal.confidence,
    });
    if (!applied.entitiesLinked.includes(resolution.entity.name)) {
      applied.entitiesLinked.push(resolution.entity.name);
    }
  }
}

/** Link all resolved entities onto another memory (update/merge targets). */
async function linkResolutionsToTarget(
  userId: string,
  targetId: string,
  resolutions: ResolutionWithProposal[],
  applied: AppliedChanges
): Promise<void> {
  for (const resolution of resolutions) {
    if (resolution.kind !== "resolved") continue;
    await linkMemoryEntity(userId, targetId, resolution.entity.id, {
      role: resolution.proposal.role,
      confidence: resolution.proposal.confidence,
    });
    if (!applied.entitiesLinkedToTarget.includes(resolution.entity.name)) {
      applied.entitiesLinkedToTarget.push(resolution.entity.name);
    }
  }
}

/** Apply one decision to the world, through the modules' public APIs. */
export async function applyDecision(
  memory: Memory,
  candidate: CandidateProposal,
  decision: Decision,
  resolutions: ResolutionWithProposal[]
): Promise<AppliedChanges> {
  const applied: AppliedChanges = {
    enriched: false,
    entitiesLinked: [],
    entitiesLinkedToTarget: [],
    ambiguousEntities: [],
    relationsCreated: [],
    versionAppended: false,
    supersededIncoming: false,
  };

  const userId = memory.userId;
  const targetId = decision.targetMemoryId;

  // ——— IGNORE: preserve the raw input; change nothing. ———
  if (decision.action === "ignore") {
    return applied;
  }

  // ——— Enrichment + entity links: every other action gets them. ———
  const patch = allowedEnrichment(memory, candidate);
  if (Object.keys(patch).length > 0) {
    await applyMemoryEnrichment(userId, memory.id, patch);
    applied.enriched = true;
  }

  await linkResolutions(userId, memory.id, resolutions, applied);

  // ——— UPDATE / CONFLICT: the newer words become the target's state. ———
  if (
    (decision.action === "update" || decision.action === "conflict") &&
    targetId &&
    targetId !== memory.id
  ) {
    // The incoming memory's own verbatim words become the target's new
    // current state; the target's previous state is preserved as a
    // version (applyMemoryStateUpdate). The incoming memory is then
    // superseded and linked with `replaces` — full provenance, nothing
    // destroyed. Idempotency: an existing replaces relation marks the
    // update as already applied, so retries never double-append.
    const alreadyApplied = await relationExists(
      userId,
      { type: "memory", id: memory.id },
      "replaces",
      { type: "memory", id: targetId }
    );

    if (!alreadyApplied) {
      await applyMemoryStateUpdate(
        userId,
        targetId,
        {
          originalContent: memory.originalContent,
          title: patch.title ?? memory.title,
          summary: patch.summary ?? null,
        },
        decision.action === "conflict"
          ? "superseded by a newer memory that contradicts this state"
          : "superseded by a newer memory"
      );
      applied.versionAppended = true;

      await createRelation(userId, {
        sourceType: "memory",
        sourceId: memory.id,
        relationType: "replaces",
        targetType: "memory",
        targetId,
        confidence: candidate.confidence,
      });
      applied.relationsCreated.push(`replaces → ${targetId}`);

      if (decision.action === "conflict") {
        await createRelation(userId, {
          sourceType: "memory",
          sourceId: memory.id,
          relationType: "contradicts",
          targetType: "memory",
          targetId,
          confidence: candidate.confidence,
        });
        applied.relationsCreated.push(`contradicts → ${targetId}`);
      }
    }

    await updateMemory(userId, memory.id, { status: "superseded" });
    applied.supersededIncoming = true;

    // The target now carries the new words, so it inherits the links too.
    await linkResolutionsToTarget(userId, targetId, resolutions, applied);
  }

  // ——— MERGE: soft, reversible, nothing destroyed. ———
  if (decision.action === "merge" && targetId && targetId !== memory.id) {
    await updateMemory(userId, memory.id, { status: "superseded" });
    applied.supersededIncoming = true;

    if (
      !(await relationExists(
        userId,
        { type: "memory", id: memory.id },
        "related_to",
        { type: "memory", id: targetId }
      ))
    ) {
      await createRelation(userId, {
        sourceType: "memory",
        sourceId: memory.id,
        relationType: "related_to",
        targetType: "memory",
        targetId,
        confidence: candidate.confidence,
      });
      applied.relationsCreated.push(`related_to → ${targetId} (merge)`);
    }

    await linkResolutionsToTarget(userId, targetId, resolutions, applied);

    // Fill only what the survivor is missing.
    const survivor = await findMemory(userId, targetId);
    if (survivor) {
      if (survivor.summary === null && candidate.summary) {
        await applyMemoryEnrichment(userId, targetId, { summary: candidate.summary });
      }
      if (survivor.memoryType === "note" && candidate.type !== "note") {
        await applyMemoryEnrichment(userId, targetId, { memoryType: candidate.type });
      }
    }
  }

  // ——— LINK: connected, still separate. ———
  if (decision.action === "link") {
    for (const link of decision.links) {
      if (link.memoryId === memory.id) continue;
      if (
        await relationExists(
          userId,
          { type: "memory", id: memory.id },
          link.relationType,
          { type: "memory", id: link.memoryId }
        )
      ) {
        continue;
      }
      await createRelation(userId, {
        sourceType: "memory",
        sourceId: memory.id,
        relationType: link.relationType,
        targetType: "memory",
        targetId: link.memoryId,
        confidence: candidate.confidence,
      });
      applied.relationsCreated.push(`${link.relationType} → ${link.memoryId}`);
    }
  }

  // ——— Entity↔entity relations: both endpoints must have resolved here. ———
  for (const relation of decision.entityRelations) {
    const source = findResolution(resolutions, relation.source.type, relation.source.name);
    const target = findResolution(resolutions, relation.target.type, relation.target.name);
    if (!source || !target || source.entity.id === target.entity.id) continue;

    if (
      await relationExists(
        userId,
        { type: "entity", id: source.entity.id },
        relation.relation_type,
        { type: "entity", id: target.entity.id }
      )
    ) {
      continue;
    }
    await createRelation(userId, {
      sourceType: "entity",
      sourceId: source.entity.id,
      relationType: relation.relation_type,
      targetType: "entity",
      targetId: target.entity.id,
      confidence: relation.confidence,
    });
    applied.relationsCreated.push(
      `${relation.relation_type}: ${relation.source.name} → ${relation.target.name}`
    );
  }

  return applied;
}

function findResolution(
  resolutions: ResolutionWithProposal[],
  type: string,
  name: string
): Extract<ResolutionWithProposal, { kind: "resolved" }> | null {
  const lowered = name.trim().toLowerCase();
  for (const resolution of resolutions) {
    if (resolution.kind !== "resolved") continue;
    if (
      resolution.proposal.type === type &&
      resolution.proposal.name.trim().toLowerCase() === lowered
    ) {
      return resolution;
    }
  }
  return null;
}

/** Serialize the applied changes into the decision provenance record. */
export function serializeApplied(applied: AppliedChanges): string {
  return JSON.stringify(applied);
}
