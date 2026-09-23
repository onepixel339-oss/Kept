/**
 * The retrieval orchestrator — the Query Orchestrator the
 * architecture doc promised.
 *
 * Executes a plan step by step, in a fixed order (structured →
 * keyword → entity → temporal → graph → semantic), accumulating seeds
 * for the graph expansion. Every retriever failure is contained: one
 * strategy failing never stops the others. Results merge, rank, and —
 * when the answer would be empty — feed ONE bounded re-planning loop
 * (spec §14): the plan widens (filters loosen, terms expand, graph
 * deepens within caps) and runs again, at most maxPlanningIterations
 * times, never blindly repeating the identical plan.
 *
 * The orchestrator owns the evidence → signal mapping for ranking
 * (temporal fit comes from the temporal retriever's presence, not
 * from re-checking dates here).
 */

import { queryConfig } from "@/config/query";
import { getMemoriesByIds } from "@/modules/memory";
import type { Memory } from "@/types/memory";
import type {
  MergedCandidate,
  RetrievalOutput,
  RetrievalResult,
  RetrievalRunInfo,
  RetrieverId,
  SearchPlan,
} from "@/types/query";
import { planQuery, widenPlan } from "../domain/planner";
import { mergeCandidates } from "../domain/merge";
import { rankCandidates } from "../domain/ranking";
import type { QueryUnderstanding } from "../domain/understanding";
import type { Retriever, RetrievalInput } from "./retrieval-types";
import { StructuredRetriever } from "./retrievers/structured";
import { KeywordRetriever } from "./retrievers/keyword";
import { EntityRetriever } from "./retrievers/entity";
import { TemporalRetriever } from "./retrievers/temporal";
import { GraphRetriever } from "./retrievers/graph";
import { SemanticRetriever, semanticAvailable } from "./retrievers/semantic";

export const STEP_ORDER: RetrieverId[] = [
  "structured",
  "keyword",
  "entity",
  "temporal",
  "graph",
  "semantic",
];

export interface OrchestratorOptions {
  /** Scope focus (chat scopes §20): a specific memory/entity/topic id. */
  scopeId?: string | null;
  /** Test seam: inject retrievers (a throwing one tests failure isolation). */
  retrievers?: Partial<Record<RetrieverId, Retriever>>;
  /** Test seam: override semantic availability detection. */
  semantic?: "available" | "deferred";
}

export interface RetrievalOutcome {
  plan: SearchPlan;
  /** Ranked, budget-bounded candidates with their memory rows. */
  candidates: Array<{ candidate: MergedCandidate; relevance: number; memory: Memory }>;
  entities: RetrievalOutput["entities"];
  ambiguity: NonNullable<RetrievalOutput["ambiguity"]>;
  failures: Array<{ retriever: RetrieverId; reason: string }>;
  semantic: RetrievalRunInfo["semantic"];
  mergedCount: number;
}

export async function runRetrieval(
  userId: string,
  message: string,
  understanding: QueryUnderstanding,
  options: OrchestratorOptions = {}
): Promise<RetrievalOutcome> {
  const budgets = queryConfig.budgets;
  const maxIterations = budgets.maxPlanningIterations;

  const semanticState: RetrievalRunInfo["semantic"] =
    options.semantic === "available" || (options.semantic === undefined && semanticAvailable())
      ? "available"
      : "deferred";

  let plan = planQuery({
    understanding,
    message,
    semanticAvailable: semanticState === "available",
    scopeId: options.scopeId ?? null,
    // For entity/topic scopes the focus id IS an entity id — the
    // planner seeds it into the entity step (chat scopes §20).
    scopeEntityId: options.scopeId ?? null,
  });

  const retrievers: Record<RetrieverId, Retriever> = {
    structured: options.retrievers?.structured ?? new StructuredRetriever(),
    keyword: options.retrievers?.keyword ?? new KeywordRetriever(),
    entity: options.retrievers?.entity ?? new EntityRetriever(),
    temporal: options.retrievers?.temporal ?? new TemporalRetriever(),
    graph: options.retrievers?.graph ?? new GraphRetriever(),
    semantic: options.retrievers?.semantic ?? new SemanticRetriever(),
  };

  const failures = new Map<RetrieverId, string>();
  let entities: RetrievalOutput["entities"] = [];
  let ambiguity: NonNullable<RetrievalOutput["ambiguity"]> = [];
  let finalCandidates: RetrievalOutcome["candidates"] = [];
  let mergedCount = 0;

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    const results: RetrievalResult[] = [];

    // ——— Execute the plan's steps, in order, failures contained ———
    const seeds = { memoryIds: [] as string[], entityIds: [] as string[] };
    const orderedSteps = [...plan.retrievalSteps].sort(
      (a, b) => STEP_ORDER.indexOf(a.kind) - STEP_ORDER.indexOf(b.kind)
    );

    for (const step of orderedSteps) {
      const retriever = retrievers[step.kind];
      const input: RetrievalInput = {
        userId,
        query: message,
        plan,
        step,
        budget: { maxResults: budgets.maxResultsPerRetriever },
        filters: plan.filters,
        // The graph step sees everything earlier steps found; seeds
        // accumulated so far are shared through this object.
        seeds,
      };

      try {
        const output = await retriever.retrieve(input);
        if (step.kind !== "graph") {
          results.push(...output.results);
          // Structured/entity/keyword hits become graph seeds.
          for (const result of output.results) {
            if (!seeds.memoryIds.includes(result.memoryId)) seeds.memoryIds.push(result.memoryId);
          }
        }
        if (output.entities?.length) {
          const seen = new Set(entities.map((entity) => entity.entityId));
          for (const entity of output.entities) {
            if (!seen.has(entity.entityId)) {
              entities.push(entity);
              if (!seeds.entityIds.includes(entity.entityId)) seeds.entityIds.push(entity.entityId);
            }
          }
        }
        if (output.ambiguity?.length) {
          ambiguity = [...ambiguity, ...output.ambiguity];
        }
      } catch (error) {
        // One retriever failing never stops the others.
        failures.set(
          step.kind,
          error instanceof Error ? error.message : "The search strategy could not run."
        );
      }
    }

    // ——— Merge, rank, evaluate ———
    const merged = mergeCandidates(results).slice(0, budgets.maxMergedCandidates);
    mergedCount = merged.length;
    const memories = await getMemoriesByIds(userId, merged.map((candidate) => candidate.memoryId));
    const memoryById = new Map(memories.map((memory) => [memory.id, memory]));

    const rankedInputs = merged.flatMap((candidate) => {
      const memory = memoryById.get(candidate.memoryId);
      if (!memory) return []; // deleted mid-run — never a candidate
      return [
        {
          candidate,
          temporal: candidate.scores.temporal ?? 0,
          importance: memory.importance,
          createdAt: memory.createdAt,
          rememberedAt: memory.rememberedAt,
        },
      ];
    });

    const ranked = rankCandidates(rankedInputs, plan.intent);
    const useful = ranked.filter((entry) => entry.relevance >= queryConfig.ranking.minUsefulScore);
    finalCandidates = ranked.slice(0, plan.limit).flatMap((entry) => {
      const memory = memoryById.get(entry.candidate.memoryId);
      if (!memory) return [];
      return [{ candidate: entry.candidate, relevance: entry.relevance, memory }];
    });

    const emptyReason: "no_results" | "no_useful_results" | null =
      ranked.length === 0 ? "no_results" : useful.length === 0 ? "no_useful_results" : null;

    // ——— Bounded re-planning ———
    if (emptyReason && iteration < maxIterations) {
      plan = widenPlan(plan, emptyReason);
      entities = [];
      ambiguity = [];
      continue;
    }

    break;
  }

  const semantic: RetrievalRunInfo["semantic"] =
    semanticState === "deferred"
      ? "deferred" // unavailable is a fact about the environment — always reported
      : plan.retrievalSteps.some((step) => step.kind === "semantic")
        ? "available"
        : "not_planned";

  return {
    plan,
    candidates: finalCandidates,
    entities,
    ambiguity,
    failures: [...failures.entries()].map(([retriever, reason]) => ({ retriever, reason })),
    semantic,
    mergedCount,
  };
}
