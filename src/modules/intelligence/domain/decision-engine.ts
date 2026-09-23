/**
 * The decision engine — deterministic application logic that turns AI
 * evidence into ONE action.
 *
 * The AI describes relationships ("these texts talk about the same
 * event", "this one contradicts that one") with confidence numbers.
 * It NEVER decides what happens. This engine does, with explicit,
 * documented, testable rules:
 *
 *   IGNORE    — the input carries no memory value (nonsense words).
 *               Raw input is always preserved regardless.
 *   CONFLICT  — new information contradicts an existing memory. The
 *               newer state wins; the older state is preserved as a
 *               version and a `contradicts` relation records the event.
 *   UPDATE    — new information clearly changes/extends an existing
 *               memory's state. Same mechanics as conflict, with a
 *               `replaces` relation and a gentler change reason.
 *   MERGE     — strong evidence both texts describe the SAME underlying
 *               memory. The duplicate is superseded (never deleted),
 *               linked back to the survivor, and its entities unioned.
 *   LINK      — clearly connected but distinct memories stay separate,
 *               joined by relations.
 *   CREATE    — the default: a meaningfully new memory.
 *
 * Non-negotiable gates (all in intelligenceConfig, with rationale):
 *   - UPDATE/CONFLICT require AI confidence ≥ updateApply AND
 *     deterministic corroboration (shared entity or keyword overlap).
 *   - MERGE requires confidence ≥ mergeApply AND strong corroboration.
 *   - Low-confidence or ambiguous proposals can only ever produce
 *     CREATE or LINK — never a rewrite of existing history.
 */

import type { DecisionAction } from "@/types/processing";
import type { AnalysisProposal, ComparisonProposal } from "./ai-schemas";
import { intelligenceConfig } from "@/config/intelligence";

/** Deterministic signals computed by the pipeline (no AI involved). */
export interface Corroboration {
  /** Per candidate memory id: ids of entities shared with the incoming memory. */
  sharedEntityIds: Record<string, string[]>;
  /** Per candidate memory id: keyword overlap (Jaccard 0..1). */
  keywordOverlap: Record<string, number>;
}

export interface DecisionInput {
  analysis: AnalysisProposal;
  comparison: ComparisonProposal;
  corroboration: Corroboration;
  /** Candidate memory ids actually shown to the model (defense in depth). */
  validMemoryIds: ReadonlySet<string>;
  /** The memory being processed — never a decision target of itself. */
  selfMemoryId: string;
}

export interface Decision {
  action: DecisionAction;
  /** The memory this action targets (update/merge/conflict/link), if any. */
  targetMemoryId: string | null;
  rationale: string;
  /** Matches eligible for LINK relations (id + proposed relation). */
  links: Array<{ memoryId: string; relationType: "related_to" | "follows" }>;
  /** Validated entity↔entity relation proposals worth persisting. */
  entityRelations: ComparisonProposal["new_relations"];
  /** Provenance record: the gates and signals this decision used. */
  trace: {
    gates: {
      updateApply: number;
      mergeApply: number;
      linkApply: number;
      corroborationOverlap: number;
      mergeOverlap: number;
    };
    corroboration: Corroboration;
  };
}

function corroborated(
  memoryId: string,
  corroboration: Corroboration,
  overlapFloor: number
): boolean {
  const shared = corroboration.sharedEntityIds[memoryId]?.length ?? 0;
  if (shared > 0) return true;
  return (corroboration.keywordOverlap[memoryId] ?? 0) >= overlapFloor;
}

/** The strongest proposal of a list, or null when none is credible. */
function strongest<T extends { memory_id: string; confidence: number }>(
  items: T[],
  validMemoryIds: ReadonlySet<string>,
  selfMemoryId: string
): T | null {
  const valid = items.filter(
    (item) => validMemoryIds.has(item.memory_id) && item.memory_id !== selfMemoryId
  );
  if (valid.length === 0) return null;
  return valid.reduce((best, item) => (item.confidence > best.confidence ? item : best));
}

export function decide(input: DecisionInput): Decision {
  const { analysis, comparison, corroboration, validMemoryIds, selfMemoryId } = input;
  const t = intelligenceConfig.thresholds;

  const trace: Decision["trace"] = {
    gates: {
      updateApply: t.updateApply,
      mergeApply: t.mergeApply,
      linkApply: t.linkApply,
      corroborationOverlap: t.corroborationOverlap,
      mergeOverlap: t.mergeOverlap,
    },
    corroboration,
  };

  const emptyLinks: Decision["links"] = [];

  // ——— IGNORE: nothing of value, nothing lost. ———
  const candidate = analysis.candidate;
  if (
    candidate.insufficient_content &&
    candidate.entities.length === 0 &&
    candidate.facts.length === 0 &&
    candidate.thoughts.length === 0
  ) {
    return {
      action: "ignore",
      targetMemoryId: null,
      rationale:
        "The input carries no memory value; the raw text is preserved untouched.",
      links: emptyLinks,
      entityRelations: [],
      trace,
    };
  }

  // ——— CONFLICT beats UPDATE: disagreement is the sharper claim. ———
  const conflict = strongest(comparison.conflicts, validMemoryIds, selfMemoryId);
  if (
    conflict &&
    conflict.confidence >= t.updateApply &&
    corroborated(conflict.memory_id, corroboration, t.corroborationOverlap)
  ) {
    return {
      action: "conflict",
      targetMemoryId: conflict.memory_id,
      rationale: conflict.reason,
      links: emptyLinks,
      entityRelations: [],
      trace,
    };
  }

  // ——— UPDATE: the newer memory clearly changes the older state. ———
  const update = strongest(comparison.updates, validMemoryIds, selfMemoryId);
  if (
    update &&
    update.confidence >= t.updateApply &&
    corroborated(update.memory_id, corroboration, t.corroborationOverlap)
  ) {
    return {
      action: "update",
      targetMemoryId: update.memory_id,
      rationale: update.reason,
      links: emptyLinks,
      entityRelations: [],
      trace,
    };
  }

  // ——— MERGE: only on the strongest evidence, with real corroboration. ———
  const merge = strongest(comparison.merge_candidates, validMemoryIds, selfMemoryId);
  if (
    merge &&
    merge.confidence >= t.mergeApply &&
    corroborated(merge.memory_id, corroboration, t.mergeOverlap)
  ) {
    return {
      action: "merge",
      targetMemoryId: merge.memory_id,
      rationale: merge.reason,
      links: emptyLinks,
      entityRelations: [],
      trace,
    };
  }

  // ——— LINK: connected, but distinct memories stay distinct. ———
  const links = comparison.matches
    .filter(
      (match) =>
        validMemoryIds.has(match.memory_id) &&
        match.memory_id !== selfMemoryId &&
        match.confidence >= t.linkApply &&
        match.memory_id !== merge?.memory_id
    )
    .slice(0, intelligenceConfig.limits.maxMemoryRelationsPerRun)
    .map((match) => ({
      memoryId: match.memory_id,
      relationType: (match.relationship === "follows" || match.relationship === "continuation"
        ? "follows"
        : "related_to") as "related_to" | "follows",
    }));

  // Entity↔entity relations: only proposals with both endpoints among
  // the candidate's own entities (the model cannot invent endpoints it
  // was not given), above the link gate, bounded per run.
  const candidateEntityNames = new Set(
    candidate.entities.map((entity) => entity.name.trim().toLowerCase())
  );
  const entityRelations = comparison.new_relations
    .filter(
      (relation) =>
        relation.confidence >= t.linkApply &&
        candidateEntityNames.has(relation.source.name.trim().toLowerCase()) &&
        candidateEntityNames.has(relation.target.name.trim().toLowerCase())
    )
    .slice(0, intelligenceConfig.limits.maxEntityRelationsPerRun);

  if (links.length > 0 || entityRelations.length > 0) {
    return {
      action: "link",
      targetMemoryId: links[0]?.memoryId ?? null,
      rationale: "Clearly connected to existing memories; kept separate and linked.",
      links,
      entityRelations,
      trace,
    };
  }

  // ——— CREATE: the honest default. ———
  return {
    action: "create",
    targetMemoryId: null,
    rationale: "A meaningfully new memory; nothing already kept covers it.",
    links: emptyLinks,
    entityRelations: [],
    trace,
  };
}
