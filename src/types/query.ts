/**
 * Shared query & retrieval types — Phase 4.
 *
 * This is the ubiquitous language of "how the user finds things again".
 * The query module (modules/query) owns the behavior; these types are
 * the vocabulary shared with the API layer, the UI, and the docs.
 *
 * Invariants that shape these types:
 *  - Retrieval is always user-scoped: nothing here carries a "global"
 *    result set; every pipeline run belongs to exactly one user.
 *  - Provenance is not optional: every retrieved memory keeps WHY it
 *    was retrieved (sources, scores, matched evidence).
 *  - Semantic retrieval is honestly deferred in this environment —
 *    the vocabulary includes its state so the system can say so.
 */

import type { EntityType } from "@/types/entity";
import type { MemoryType } from "@/types/memory";

/* ————————————————— Query understanding ————————————————— */

/** What the user is trying to do with their question. */
export const QUERY_INTENTS = [
  "recall", // "فاكر أحمد؟" — do I have anything about X
  "find", // "ذكرياتي في سبتمبر" — show me what matches
  "summary", // "لخصلي الشهر اللي فات" — condense
  "timeline", // "إمتى قابلت أحمد أول مرة؟" / what happened when
  "comparison", // "الفرق بين..." — compare across memories
  "explore", // "إيه اللي حصل في الصيف اللي فات؟" — browse a space
  "reflect", // "إيه اللي اتغير في علاقتي بأحمد؟" — longitudinal
] as const;

export type QueryIntent = (typeof QUERY_INTENTS)[number];

/** Where the question looks. Chat scopes (spec §20) share this vocabulary. */
export const QUERY_SCOPES = ["global", "memory", "entity", "topic"] as const;

export type QueryScope = (typeof QUERY_SCOPES)[number];

/** How broad the retrieval should be. Drives budgets. */
export const QUERY_DEPTHS = ["narrow", "medium", "broad"] as const;

export type QueryDepth = (typeof QUERY_DEPTHS)[number];

/**
 * A person/place/thing the user mentioned BY NAME in the question.
 * Mentions are evidence, not resolved entities — resolution happens
 * against the user's own entities, deterministically-first, with
 * ambiguity preserved (never silently combined).
 */
export interface QueryEntityMention {
  /** The name exactly as the user wrote it. */
  mention: string;
  /** Proposed type; may be null when the question does not say. */
  type: EntityType | null;
  /** Optional qualifier: "أحمد بتاع المشروع" → mention "أحمد", qualifier "project". */
  qualifier?: string | null;
  /**
   * Untrusted hint from understanding: a saved entity the mention may
   * refer to. Must be validated against the run's known-entity list
   * (and then against ownership) before any retriever uses it.
   */
  entityId?: string | null;
}

/**
 * A resolved temporal constraint. Dates are ISO 8601 strings resolved
 * against the question's current date/timezone. Uncertainty is PART of
 * the data: an approximate window says so — the system never fabricates
 * certainty about time.
 */
export interface QueryTimeRange {
  /** How the time was expressed. */
  kind: "none" | "exact" | "range" | "month" | "year" | "relative" | "before" | "after";
  /** Window start (ISO, inclusive), when resolvable. */
  from: string | null;
  /** Window end (ISO, inclusive), when resolvable. */
  to: string | null;
  /** The user's raw words for this constraint. */
  expression: string | null;
  /** True when the window involves an assumption (e.g. "last summer"). */
  uncertain: boolean;
}

/* ————————————————— Search plan ————————————————— */

/** The retrieval mechanisms the planner can schedule. */
export const RETRIEVER_IDS = [
  "structured",
  "keyword",
  "entity",
  "temporal",
  "graph",
  "semantic",
] as const;

export type RetrieverId = (typeof RETRIEVER_IDS)[number];

/**
 * One scheduled retrieval step. Config is step-specific plain data —
 * the planner knows WHAT to run, never HOW a retriever is implemented.
 */
export type RetrievalStep =
  | { kind: "structured"; config: { memoryTypes?: MemoryType[]; memoryIds?: string[] } }
  | { kind: "keyword"; config: { terms: string[] } }
  | {
      kind: "entity";
      config: {
        mentions: Array<{ mention: string; type: EntityType | null; qualifier?: string | null; entityId?: string | null }>;
        topics: string[];
        /**
         * Scope seeding (chat scopes §20): when the conversation is
         * focused on one saved entity/topic, that entity joins the
         * retrieval as a first-class seed — even when the question
         * doesn't name it. Ownership is re-verified by the retriever.
         */
        scopeEntityId?: string | null;
      };
    }
  | { kind: "temporal"; config: { windows: Array<{ from: string | null; to: string | null; uncertain: boolean }> } }
  | { kind: "graph"; config: { depth: number } }
  | { kind: "semantic"; config: Record<string, unknown> };

/** Filters every retriever must respect (in addition to ownership). */
export interface QueryFilters {
  /** Lifecycle statuses allowed into candidates. Default: active. */
  statuses: Array<"active" | "archived" | "superseded">;
  /** Optional memory-type restriction. */
  memoryTypes?: MemoryType[];
}

/** How much reasoning the question ultimately deserves (Phase 5 executes it). */
export type ReasoningMode = "none" | "light" | "full";

/**
 * The plan. Produced by the planner, executed by the orchestrator,
 * adjusted by bounded re-planning. Every value is validated.
 */
export interface SearchPlan {
  intent: QueryIntent;
  scope: QueryScope;
  depth: QueryDepth;
  retrievalSteps: RetrievalStep[];
  filters: QueryFilters;
  keywords: string[];
  /** Final-memory budget for this plan's depth. */
  limit: number;
  /** Graph traversal depth for this plan (≤ config cap). */
  graphDepth: number;
  reasoningMode: ReasoningMode;
  /** Which planning iteration produced this plan (1-based, bounded). */
  iteration: number;
}

/* ————————————————— Retrieval results ————————————————— */

/** One memory surfaced by one retriever — with its evidence. */
export interface RetrievalResult {
  memoryId: string;
  /** Which retriever produced this result. */
  source: RetrieverId;
  /** 0..1 — strength of THIS retriever's evidence. */
  score: number;
  /** Entity ids that connected this memory to the question. */
  matchedEntityIds: string[];
  /** Query terms found in the memory's text. */
  matchedTerms: string[];
  /** Graph distance from the nearest seed (graph retriever only). */
  graphDistance?: number;
  /** One-line, human-readable why — provenance, not debug. */
  reason: string;
}

/**
 * What one retriever step returns: results, plus step-specific
 * side-products the orchestrator and context builder consume.
 */
export interface RetrievalOutput {
  results: RetrievalResult[];
  /** Entity resolution evidence (entity retriever). */
  entities?: Array<{
    entityId: string;
    name: string;
    type: string;
    /** How the mention matched: exact | normalized | alias | partial | ai
     *  ("ai" = the understanding model PROPOSED the reference; used only
     *  when deterministic matching found nothing strong, never when it
     *  found ambiguity) | scope ("scope" = the conversation's focused
     *  entity/topic, chat scopes §20). */
    basis: "exact" | "normalized" | "alias" | "partial" | "ai" | "scope";
    mention: string;
  }>;
  /** A mention matched more than one plausible entity — never merged. */
  ambiguity?: Array<{
    mention: string;
    candidates: Array<{ entityId: string; name: string; type: string }>;
  }>;
  /** Honest unavailability (semantic retriever while embeddings defer). */
  unavailable?: { reason: string };
}

/* ————————————————— Merged & ranked candidates ————————————————— */

/** Several retrievers may surface the same memory — this is the union. */
export interface MergedCandidate {
  memoryId: string;
  sources: RetrieverId[];
  /** Best score per contributing retriever. */
  scores: Partial<Record<RetrieverId, number>>;
  matchedEntityIds: string[];
  matchedTerms: string[];
  /** Minimum graph distance across contributing results. */
  minGraphDistance?: number;
  /** Deterministic relevance to THIS query, 0..1 (after ranking). */
  relevance: number;
}

/* ————————————————— Context pack (the Phase 5 boundary) ————————————————— */

/** Provenance attached to every memory that enters the context. */
export interface MemoryProvenance {
  sources: RetrieverId[];
  scores: Partial<Record<RetrieverId, number>>;
  matchedEntityIds: string[];
  matchedTerms: string[];
  graphDistance?: number;
  relevance: number;
  reason: string;
}

/** A context memory: what was kept + why it is here. */
export interface ContextMemory {
  memoryId: string;
  title: string | null;
  snippet: string;
  memoryType: string;
  /** When the remembered thing happened (null when unknown). */
  rememberedAt: string | null;
  /** When it was kept. */
  createdAt: string;
  provenance: MemoryProvenance;
}

/** An entity that helped answer the question. */
export interface ContextEntity {
  entityId: string;
  name: string;
  type: string;
  basis: "exact" | "normalized" | "alias" | "partial" | "ai" | "scope";
}

/** A graph edge touching the context's memories/entities. */
export interface ContextRelation {
  relationId: string;
  relationType: string;
  sourceType: string;
  sourceId: string;
  targetType: string;
  targetId: string;
  sourceLabel: string | null;
  targetLabel: string | null;
}

/** One point on a timeline, for timeline-oriented intents. */
export interface ContextTimelinePoint {
  memoryId: string;
  title: string | null;
  when: string | null;
  /** True when the date is the kept-date proxy, not a known event date. */
  dateIsProxy: boolean;
}

/** How the retrieval actually ran — provenance for the whole run. */
export interface RetrievalRunInfo {
  /** "ai" when the AI understood the question; "fallback" when the
   *  deterministic understatnding had to take over. */
  understandingSource: "ai" | "fallback";
  planIterations: number;
  /** Retriever steps that failed; the rest still ran. */
  failures: Array<{ retriever: RetrieverId; reason: string }>;
  /** Always "deferred" in this environment — honestly stated, never faked. */
  semantic: "deferred" | "available" | "not_planned";
  /** Candidates merged before the final cut. */
  mergedCandidates: number;
}

/**
 * The ContextPack — everything Phase 5 reasoning will receive, and
 * everything Phase 4's API returns shaped for the UI. Never the whole
 * database: only what the planner found and the ranker kept.
 */
export interface ContextPack {
  query: string;
  scope: QueryScope;
  understanding: {
    intent: QueryIntent;
    depth: QueryDepth;
    mentions: QueryEntityMention[];
    topics: string[];
    time: QueryTimeRange;
    needsReasoning: boolean;
  };
  memories: ContextMemory[];
  entities: ContextEntity[];
  relations: ContextRelation[];
  timeline: ContextTimelinePoint[];
  uncertainties: string[];
  ambiguity: Array<{
    mention: string;
    candidates: Array<{ entityId: string; name: string; type: string }>;
  }>;
  run: RetrievalRunInfo;
}
