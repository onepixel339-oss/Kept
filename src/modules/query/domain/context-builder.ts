/**
 * Context builder — the boundary between retrieval and reasoning.
 *
 * Receives the ranked candidates (with full provenance), the resolved
 * entities, and the run's honest telemetry; produces the ContextPack
 * Phase 5's reasoning will consume and Phase 4's API returns. It never
 * sends "the whole database" — only what the planner found and the
 * ranker kept, each memory carrying WHY it is here.
 *
 * Memory ordering is intent-aware (spec §16):
 *  - timeline           → chronological (event date, kept-date proxy flagged)
 *  - recall/find        → direct relevance
 *  - summary/comparison → relevance with a gentle chronological frame
 *  - explore/reflect    → coverage and diversity first (each new memory
 *                         should add an entity the pack has not seen)
 */

import { queryConfig } from "@/config/query";
import { snippet } from "@/lib/format";
import type { Memory } from "@/types/memory";
import type { Entity } from "@/types/entity";
import type { Relation } from "@/types/relation";
import type {
  ContextPack,
  ContextTimelinePoint,
  MergedCandidate,
  QueryIntent,
  RetrievalRunInfo,
} from "@/types/query";
import type { QueryUnderstanding } from "./understanding";

export interface BuildContextInput {
  query: string;
  understanding: QueryUnderstanding;
  /** Ranked candidates (bounded by the plan's final-memory budget). */
  candidates: Array<{ candidate: MergedCandidate; memory: Memory }>;
  /** Entities that resolved against the question (deduped). */
  entities: ContextPack["entities"];
  /** Relations touching the context's memories/entities (bounded). */
  relations: ContextPack["relations"];
  /** Mentions that matched several entities — preserved, never merged. */
  ambiguity: ContextPack["ambiguity"];
  /** Honest run telemetry. */
  run: RetrievalRunInfo;
}

export function buildContext(input: BuildContextInput): ContextPack {
  const { understanding } = input;
  const memories = input.candidates.slice(0, queryConfig.budgets.contextMaxMemories);

  const ordered = orderMemories(memories, understanding.intent);

  const timeline: ContextTimelinePoint[] =
    understanding.intent === "timeline" ||
    understanding.intent === "summary" ||
    understanding.intent === "reflect"
      ? ordered.map(({ memory }) => ({
          memoryId: memory.id,
          title: memory.title,
          when: (memory.rememberedAt ?? memory.createdAt).toISOString(),
          dateIsProxy: memory.rememberedAt === null,
        }))
      : [];

  const uncertainties = collectUncertainties(input);

  return {
    query: input.query,
    scope: understanding.scope,
    understanding: {
      intent: understanding.intent,
      depth: understanding.depth,
      mentions: understanding.mentions,
      topics: understanding.topics,
      time: understanding.time,
      needsReasoning: understanding.needsReasoning,
    },
    memories: ordered.map(({ candidate, memory }) => ({
      memoryId: memory.id,
      title: memory.title,
      snippet: snippet(memory.originalContent),
      memoryType: memory.memoryType,
      rememberedAt: memory.rememberedAt ? memory.rememberedAt.toISOString() : null,
      createdAt: memory.createdAt.toISOString(),
      provenance: {
        sources: candidate.sources,
        scores: candidate.scores,
        matchedEntityIds: candidate.matchedEntityIds,
        matchedTerms: candidate.matchedTerms,
        graphDistance: candidate.minGraphDistance,
        relevance: candidate.relevance,
        reason: describeReason(candidate, memory),
      },
    })),
    entities: input.entities,
    relations: input.relations.slice(0, queryConfig.budgets.contextMaxRelations),
    timeline,
    uncertainties,
    ambiguity: input.ambiguity,
    run: input.run,
  };
}

/* ————————————————— Intent-aware ordering ————————————————— */

function orderMemories(
  memories: Array<{ candidate: MergedCandidate; memory: Memory }>,
  intent: QueryIntent
): Array<{ candidate: MergedCandidate; memory: Memory }> {
  const byRelevance = [...memories].sort((a, b) => b.candidate.relevance - a.candidate.relevance);

  switch (intent) {
    case "timeline":
      return chronological(memories);
    case "summary":
    case "comparison":
      // Relevance leads; ties and near-ties read chronologically.
      return [...byRelevance].sort((a, b) => {
        const delta = b.candidate.relevance - a.candidate.relevance;
        if (Math.abs(delta) > 0.05) return delta;
        return effectiveDate(a.memory).getTime() - effectiveDate(b.memory).getTime();
      });
    case "explore":
    case "reflect":
      return coverageFirst(byRelevance);
    default:
      return byRelevance;
  }
}

function chronological(memories: Array<{ candidate: MergedCandidate; memory: Memory }>) {
  return [...memories].sort(
    (a, b) => effectiveDate(a.memory).getTime() - effectiveDate(b.memory).getTime()
  );
}

/**
 * Coverage-first ordering: walk the relevance-sorted list, always
 * taking the next memory that introduces unseen entities before ones
 * the pack already covers. Deterministic greedy diversity.
 */
function coverageFirst(byRelevance: Array<{ candidate: MergedCandidate; memory: Memory }>) {
  const seenEntities = new Set<string>();
  const remaining = [...byRelevance];
  const ordered: Array<{ candidate: MergedCandidate; memory: Memory }> = [];

  while (remaining.length > 0) {
    const nextIndex = remaining.findIndex(
      ({ candidate }) => !candidate.matchedEntityIds.every((id) => seenEntities.has(id)) || candidate.matchedEntityIds.length === 0
    );
    const pickIndex = nextIndex === -1 ? 0 : nextIndex;
    const [picked] = remaining.splice(pickIndex, 1);
    for (const entityId of picked.candidate.matchedEntityIds) seenEntities.add(entityId);
    ordered.push(picked);
  }

  return ordered;
}

function effectiveDate(memory: Memory): Date {
  return memory.rememberedAt ?? memory.createdAt;
}

/* ————————————————— Provenance description ————————————————— */

/** One honest line: why this memory is in the context. */
function describeReason(candidate: MergedCandidate, memory: Memory): string {
  const parts: string[] = [];
  if (candidate.sources.includes("structured")) {
    parts.push("the memory you asked about");
  }
  if (candidate.matchedEntityIds.length > 0) {
    parts.push(`matches ${candidate.matchedEntityIds.length} of your people & things`);
  }
  if (candidate.matchedTerms.length > 0) {
    parts.push(`mentions “${candidate.matchedTerms.slice(0, 3).join("’, ‘")}”`);
  }
  if (candidate.minGraphDistance !== undefined) {
    parts.push(
      candidate.minGraphDistance === 1
        ? "directly connected in your graph"
        : `${candidate.minGraphDistance} steps away in your graph`
    );
  }
  if (parts.length === 0) {
    parts.push(memory.rememberedAt ? "falls in the asked-about time" : "surfaced by search");
  }
  return parts.join("; ");
}

/* ————————————————— Uncertainty collection ————————————————— */

function collectUncertainties(input: BuildContextInput): string[] {
  const uncertainties: string[] = [];
  const { understanding, run } = input;

  if (understanding.time.expression && understanding.time.uncertain) {
    uncertainties.push(`The time “${understanding.time.expression}” is approximate — Kept made an assumption to search.`);
  } else if (understanding.time.uncertain) {
    uncertainties.push("The time range is approximate — Kept made an assumption to search.");
  }

  for (const ambiguity of input.ambiguity) {
    uncertainties.push(
      `“${ambiguity.mention}” matched more than one saved ${ambiguity.candidates[0]?.type ?? "thing"} — both were searched separately.`
    );
  }

  if (run.understandingSource === "fallback") {
    uncertainties.push("Kept read this question with its own words, not its understanding model.");
  }

  if (run.failures.length > 0) {
    uncertainties.push("Some search strategies could not run; the rest of the search still did.");
  }

  return uncertainties;
}
