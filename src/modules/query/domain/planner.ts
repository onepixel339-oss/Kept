/**
 * The Query Planner — deterministic, inspectable, bounded.
 *
 * Receives a validated QueryUnderstanding and produces a SearchPlan:
 * WHICH retrieval mechanisms to run, with what filters, at what
 * budget. The planner never talks to the database, never calls a
 * model, and never knows how a retriever is implemented — it emits
 * intent, the orchestrator executes it.
 *
 * Planning rules (spec §2's examples, generalized):
 *  - explicit time (month/year/window)            → structured + temporal
 *  - entity mentions / recall questions           → entity + keyword
 *  - entity + topic together                      → entity + keyword + graph
 *  - summaries / timelines / reflections          → entity/topic + temporal + graph + chronological ordering
 *  - semantic is scheduled ONLY when embeddings
 *    are available — honestly deferred otherwise
 *
 * Re-planning (`widenPlan`) is the planner's second half: bounded
 * broadening when retrieval came back empty — loosen filters, expand
 * keyword terms, deepen the graph within caps. It NEVER retries the
 * identical plan (that's what iteration tracking guarantees).
 */

import { queryConfig } from "@/config/query";
import { MEMORY_STATUSES } from "@/types/memory";
import type { QueryDepth, QueryFilters, RetrievalStep, SearchPlan } from "@/types/query";
import type { QueryUnderstanding } from "./understanding";
import { extractQueryTerms } from "./terms";

export type { SearchPlan };

/* ————————————————— planQuery ————————————————— */

export interface PlanRequest {
  understanding: QueryUnderstanding;
  /** The raw question — for keyword probing terms. */
  message: string;
  /** Whether the semantic retriever can actually run right now. */
  semanticAvailable: boolean;
  /** Scope seeds (chat scopes §20): a focused memory/entity/topic id. */
  scopeId?: string | null;
  /**
   * The focused entity/topic id when scope is "entity" or "topic" —
   * seeded into the entity step so scoped conversations retrieve the
   * focused thing's memories even when the question doesn't name it.
   */
  scopeEntityId?: string | null;
}

export function planQuery(request: PlanRequest): SearchPlan {
  const { understanding, semanticAvailable, message } = request;
  const budgets = queryConfig.budgets;
  const steps: RetrievalStep[] = [];
  const filters: QueryFilters = { statuses: ["active"] };
  const keywords = extractQueryTerms(message);

  // ——— Entity step: whenever the question names things, or the
  //      conversation is focused on one saved entity/topic ———
  const hasMentions = understanding.mentions.length > 0;
  const hasTopics = understanding.topics.length > 0;
  const scopeEntityId =
    (understanding.scope === "entity" || understanding.scope === "topic")
      ? request.scopeEntityId ?? null
      : null;
  if (hasMentions || hasTopics || scopeEntityId) {
    steps.push({
      kind: "entity",
      config: {
        mentions: understanding.mentions.map((mention) => ({
          mention: mention.mention,
          type: mention.type,
          qualifier: mention.qualifier ?? null,
          entityId: mention.entityId ?? null,
        })),
        topics: understanding.topics,
        scopeEntityId,
      },
    });
  }

  // ——— Structured step: exact reads for a scope-focused memory ———
  if (request.scopeId && understanding.scope === "memory") {
    steps.push({ kind: "structured", config: { memoryIds: [request.scopeId] } });
  }

  // ——— Keyword step: the user's words probe their own text ———
  if (keywords.length > 0 || hasMentions) {
    const terms = [
      ...keywords,
      ...understanding.mentions.map((mention) => mention.mention),
      ...understanding.topics,
    ]
      .map((term) => term.trim())
      .filter((term) => term !== "" && term.length > 1);
    // Deduplicate case-insensitively — "Ahmed" and "ahmed" are one probe.
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const term of terms) {
      const key = term.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(term);
    }
    if (unique.length > 0) {
      steps.push({ kind: "keyword", config: { terms: unique.slice(0, budgets.maxKeywordTerms) } });
    }
  }

  // ——— Temporal step: only when a window actually resolved ———
  if (understanding.time.from || understanding.time.to) {
    steps.push({
      kind: "temporal",
      config: {
        windows: [
          { from: understanding.time.from, to: understanding.time.to, uncertain: understanding.time.uncertain },
        ],
      },
    });
  }

  // ——— Graph step: connect what the entity step resolves ———
  // Depth: 1 for simple lookups, 2 for normal connected questions,
  // 3 only for explicitly broad exploration (spec §7).
  const wantsGraph =
    (hasMentions && understanding.intent !== "recall") ||
    hasTopics ||
    understanding.intent === "summary" ||
    understanding.intent === "timeline" ||
    understanding.intent === "reflect" ||
    understanding.intent === "comparison" ||
    understanding.scope === "memory" ||
    understanding.scope === "entity";
  if (wantsGraph) {
    const depth = graphDepthFor(understanding.depth);
    steps.push({ kind: "graph", config: { depth } });
  }

  // ——— Semantic step: only when it can honestly run, and only when
  //      meaning-level similarity plausibly helps (spec §10). Date-
  //      anchored listing questions are temporal/structured territory —
  //      semantic is NOT blindly scheduled on every query:
  //        "ذكريات أغسطس"                     → structured + temporal (window resolved, listing intent)
  //        "فاكر اليوم اللي قضيناه على البحر؟" → semantic (meaning-led recall)
  //        "إيه اللي حصل بيني وبين أحمد؟"      → entity + graph + keyword + semantic
  // ———
  const timeWindowResolved = Boolean(understanding.time.from || understanding.time.to);
  const meaningLedIntent =
    understanding.intent === "recall" ||
    understanding.intent === "explore" ||
    understanding.intent === "reflect" ||
    understanding.intent === "comparison";
  const wantsSemantic = semanticAvailable && (!timeWindowResolved || meaningLedIntent);
  if (wantsSemantic) {
    steps.push({ kind: "semantic", config: {} });
  }

  const graphStep = steps.find((step) => step.kind === "graph");

  return {
    intent: understanding.intent,
    scope: understanding.scope,
    depth: understanding.depth,
    retrievalSteps: steps,
    filters,
    keywords,
    limit: budgets.maxFinalMemories[understanding.depth] ?? budgets.maxFinalMemories.medium,
    graphDepth: graphStep && graphStep.kind === "graph" ? graphStep.config.depth : 0,
    reasoningMode: understanding.needsReasoning ? "light" : "none",
    iteration: 1,
  };
}

/** Graph depth by question breadth, hard-capped by configuration. */
function graphDepthFor(depth: QueryDepth): number {
  const cap = queryConfig.budgets.maxGraphDepth;
  const requested = depth === "narrow" ? 1 : depth === "medium" ? 2 : 3;
  return Math.min(requested, cap);
}

/* ————————————————— Re-planning (bounded) ————————————————— */

/**
 * Produce the NEXT plan when retrieval quality was insufficient.
 * Bounded by construction: the orchestrator never calls this more
 * than maxPlanningIterations - 1 times, and each widening is
 * monotonic (filters loosen, terms expand, graph deepens) so a plan
 * can never oscillate.
 *
 * Widening moves, in order:
 *  1. include archived memories alongside active
 *  2. drop the temporal window when it produced nothing (uncertainty
 *     in the understanding should not starve the search)
 *  3. expand keyword terms (individual long terms split; more probes)
 *  4. deepen the graph within the configured cap
 */
/** Type-preserving deep copy of plan steps — widenPlan never mutates its input. */
function copySteps(steps: RetrievalStep[]): RetrievalStep[] {
  return steps.map((step) => {
    switch (step.kind) {
      case "structured":
        return { kind: "structured" as const, config: { ...step.config } };
      case "keyword":
        return { kind: "keyword" as const, config: { terms: [...step.config.terms] } };
      case "entity":
        return {
          kind: "entity" as const,
          config: {
            mentions: step.config.mentions.map((mention) => ({ ...mention })),
            topics: [...step.config.topics],
          },
        };
      case "temporal":
        return { kind: "temporal" as const, config: { windows: step.config.windows.map((w) => ({ ...w })) } };
      case "graph":
        return { kind: "graph" as const, config: { depth: step.config.depth } };
      case "semantic":
        return { kind: "semantic" as const, config: {} };
    }
  });
}

export function widenPlan(plan: SearchPlan, emptyReason: "no_results" | "no_useful_results"): SearchPlan {
  const next: SearchPlan = {
    ...plan,
    iteration: plan.iteration + 1,
    filters: { ...plan.filters },
    retrievalSteps: copySteps(plan.retrievalSteps),
    keywords: [...plan.keywords],
  };

  // 1. Loosen the lifecycle filter.
  next.filters.statuses = [...MEMORY_STATUSES].filter((status) => status !== "superseded") as QueryFilters["statuses"];

  // 2. Drop the temporal constraint that starved the search.
  if (emptyReason === "no_results") {
    next.retrievalSteps = next.retrievalSteps.filter((step) => step.kind !== "temporal");
  }

  // 3. Expand keyword probes.
  const keywordStep = next.retrievalSteps.find((step): step is Extract<typeof step, { kind: "keyword" }> => step.kind === "keyword");
  if (keywordStep) {
    const expanded = new Set(keywordStep.config.terms);
    for (const term of keywordStep.config.terms) {
      for (const part of term.split(/\s+/)) {
        if (part.length > 1) expanded.add(part);
      }
    }
    // Add the plan's reserved keywords as last-resort probes.
    for (const term of next.keywords) expanded.add(term);
    keywordStep.config.terms = [...expanded].slice(0, queryConfig.budgets.maxKeywordTerms + 4);
  } else if (next.keywords.length > 0) {
    next.retrievalSteps.push({ kind: "keyword", config: { terms: next.keywords.slice(0, queryConfig.budgets.maxKeywordTerms) } });
  }

  // 4. Deepen the graph within the cap.
  const graphStep = next.retrievalSteps.find((step): step is Extract<typeof step, { kind: "graph" }> => step.kind === "graph");
  if (graphStep) {
    graphStep.config.depth = Math.min(graphStep.config.depth + 1, queryConfig.budgets.maxGraphDepth);
  } else {
    next.retrievalSteps.push({ kind: "graph", config: { depth: 1 } });
  }

  return next;
}
