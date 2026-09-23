/**
 * Intelligence configuration — the pipeline's bounded, tunable dials.
 *
 * Every number here exists because a behavior needed a guardrail, and
 * each carries its rationale inline. They are configuration, not laws:
 * tune them as evidence accumulates, but document why.
 */

export const intelligenceConfig = {
  limits: {
    /**
     * Candidate memories shown to the comparison step. Kept small so
     * the model compares carefully instead of skimming a long list,
     * and so a prompt can never leak more than this many memories.
     */
    maxCandidateMemories: 10,
    /** Candidate entities per entity type offered for resolution. */
    maxCandidateEntitiesPerType: 10,
    /** Distinct search terms extracted from one memory for retrieval. */
    maxKeywordTerms: 6,
    /**
     * Relation creation is deliberately stingy — a handful of meaningful
     * edges beats a speculative web. Per processing run.
     */
    maxMemoryRelationsPerRun: 3,
    maxEntityRelationsPerRun: 2,
    /** Entity proposals per memory accepted from one analysis. */
    maxEntitiesPerMemory: 8,
    /** Words kept after stopword filtering for keyword retrieval. */
    maxKeywords: 12,
  },

  thresholds: {
    /**
     * Auto-linking an entity on NON-deterministic (alias/fuzzy) evidence
     * requires the proposer to be at least this sure. Exact and unique
     * normalized matches bypass this gate — they are deterministic, not
     * guesses. 0.65: below this, "maybe the same person" is too weak to
     * attach a face to a memory.
     */
    entityAutoLink: 0.65,

    /**
     * Applying UPDATE/CONFLICT to an EXISTING memory rewrites its current
     * state (history preserved). This gate requires strong agreement from
     * the proposer AND deterministic corroboration (shared entity or
     * keyword overlap) — see `corroborationOverlap`. 0.75: updating the
     * wrong memory is worse than leaving a duplicate.
     */
    updateApply: 0.75,

    /**
     * MERGE is the most destructive-looking action, so it gets the
     * highest gate. 0.85 plus corroboration: false merges destroy
     * distinctions the user may care about; duplicate memories merely
     * coexist. When in doubt, keep separate.
     */
    mergeApply: 0.85,

    /** Creating a relation between two memories (LINK). 0.70: relations
     * are cheap to create but a wrong edge pollutes the graph quietly. */
    linkApply: 0.7,

    /**
     * Deterministic corroboration floor for UPDATE/CONFLICT/MERGE:
     * keyword overlap (Jaccard) between the incoming memory and the
     * candidate target. AI confidence alone never rewrites an existing
     * memory — the words themselves must agree too.
     */
    corroborationOverlap: 0.3,
    /** Strong corroboration for MERGE (in addition to its 0.85 gate). */
    mergeOverlap: 0.35,

    /**
     * Applying an AI-normalized date to `rememberedAt`. 0.8: a date is
     * a hard claim about the past; "maybe 2024" (low confidence) must
     * stay uncertain rather than become a fact. Only applies when the
     * user did not provide a date themselves.
     */
    timeApply: 0.8,
  },
} as const;

export type IntelligenceConfig = typeof intelligenceConfig;
