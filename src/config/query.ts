/**
 * Query configuration — the retrieval engine's bounded, tunable dials.
 *
 * Same discipline as config/intelligence.ts: every number exists
 * because a behavior needed a guardrail, each carries its rationale,
 * and none of them are hardcoded truths. Retrieval budgets protect the
 * user's database from excessive reads and Phase 5's reasoning step
 * from unbounded context.
 */

export const queryConfig = {
  budgets: {
    /**
     * Ceiling on candidates a single retriever may contribute. Small
     * enough that one noisy retriever cannot flood the merge.
     */
    maxResultsPerRetriever: 12,
    /** Ceiling on the merged candidate pool before ranking. */
    maxMergedCandidates: 40,
    /** Hard cap on graph traversal depth — depth 3 is for explicitly
     *  broad exploration only; the planner never exceeds it. */
    maxGraphDepth: 3,
    /** Hard cap on distinct graph nodes visited per traversal. */
    maxGraphNodes: 24,
    /** Distinct keyword probes derived from one question. */
    maxKeywordTerms: 6,
    /** Final memories kept, by plan depth. Simple questions deserve
     *  small, confident answers; broad explorations may see more. */
    maxFinalMemories: { narrow: 8, medium: 15, broad: 25 } as Record<string, number>,
    /** Planning iterations per question (spec §14: bounded re-planning). */
    maxPlanningIterations: 2,
    /** AI calls per ask run. Phase 4 spends it on understanding only;
     *  reasoning (Phase 5) will raise this deliberately. */
    maxAiCalls: 1,
    /** Recent messages fed to understanding for follow-up resolution. */
    conversationWindow: 8,
    /** Ceiling on memories inside one ContextPack. */
    contextMaxMemories: 30,
    /** Ceiling on relations attached to one ContextPack. */
    contextMaxRelations: 20,

    /**
     * Phase 8 (spec §13) — semantic budgets. Semantic retrieval is
     * potentially expensive, so it is bounded like everything else:
     * one query embedding per question (the retriever embeds the
     * question exactly once and never persists it), a cap on semantic
     * hits per run, and a cosine floor below which a hit is noise,
     * not a candidate. The floor is deliberately LOW: exact matches
     * stay the domain of entity/keyword retrieval — semantic only
     * needs to surface meaning-level relatives, and the deterministic
     * ranker decides what survives.
     */
    maxQueryEmbeddingCalls: 1,
    maxSemanticResults: 10,
    minSemanticScore: 0.2,
  },

  ranking: {
    /**
     * Below this relevance a candidate is "not useful" — the trigger
     * for one bounded re-plan (broaden keywords, widen filters).
     * Calibrated so a direct entity match on a timeline question
     * (whose temporal weight dominates) still counts as useful:
     * timeline weights give entity 0.10, so a real match lands ≈0.22.
     */
    minUsefulScore: 0.2,

    /**
     * Signal weights per intent. Each signal is normalized 0..1 before
     * weighting; the weighted sum is the candidate's relevance.
     * Weights are judgment calls, documented per intent, tuned by
     * evidence over time — configuration, not law.
     *
     *  entity      — did a resolved entity connect to it (strongest
     *                evidence a personal question is about this)
     *  keyword     — did the user's words appear in its text
     *  semantic    — cosine similarity between the question and the
     *                memory's canonical embedding (Phase 8 §12). A
     *                meaning-level signal ONLY: it never replaces the
     *                exact signals, and its weight is tuned so a direct
     *                entity/keyword match still outranks a merely
     *                similar memory (spec §11 — "Ahmed" must stay an
     *                entity win). Zero effect while embeddings are
     *                deferred: no candidate carries a semantic score.
     *  temporal    — does it fall in the asked-about window
     *  graph       — how close is it in the user's own graph
     *  importance  — the memory's stored importance (a proposal)
     *  recency     — gentle recency pull (half-life ≈ 1 year)
     *  sourceCount — corroboration: multiple retrievers agreeing
     */
    weights: {
      recall: { entity: 0.35, keyword: 0.2, semantic: 0.2, temporal: 0.05, graph: 0.05, importance: 0.05, recency: 0.05, sourceCount: 0.05 },
      find: { entity: 0.25, keyword: 0.3, semantic: 0.1, temporal: 0.1, graph: 0.1, importance: 0.05, recency: 0.05, sourceCount: 0.05 },
      summary: { entity: 0.15, keyword: 0.15, semantic: 0.1, temporal: 0.2, graph: 0.1, importance: 0.15, recency: 0.05, sourceCount: 0.1 },
      timeline: { entity: 0.1, keyword: 0.1, semantic: 0.05, temporal: 0.35, graph: 0.05, importance: 0.1, recency: 0.1, sourceCount: 0.15 },
      comparison: { entity: 0.2, keyword: 0.2, semantic: 0.1, temporal: 0.15, graph: 0.15, importance: 0.05, recency: 0.05, sourceCount: 0.1 },
      explore: { entity: 0.2, keyword: 0.2, semantic: 0.1, temporal: 0.15, graph: 0.1, importance: 0.15, recency: 0.05, sourceCount: 0.05 },
      reflect: { entity: 0.25, keyword: 0.1, semantic: 0.15, temporal: 0.15, graph: 0.15, importance: 0.05, recency: 0.05, sourceCount: 0.1 },
    } as Record<string, Record<string, number>>,

    /** Recency half-life in days for the recency signal. */
    recencyHalfLifeDays: 365,
  },

  search: {
    /** /api/search response sizes — small and useful, per spec §18. */
    maxMemories: 10,
    maxEntities: 8,
    maxTopics: 6,
  },
} as const;

export type QueryConfig = typeof queryConfig;
