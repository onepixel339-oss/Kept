/**
 * The Retriever contract — the planner's vocabulary, the retrievers'
 * obligation.
 *
 * A retriever knows ONE way of finding memories. It receives plain
 * data (a plan step, a budget, seeds from earlier steps, filters) and
 * returns evidence: which memories it found, how strongly, and why.
 * It never talks to the planner, never knows the intent, never sees
 * another retriever — failures are isolated by the orchestrator.
 *
 * Ownership is structural: every retriever's input carries the userId
 * and every underlying read is user-scoped. There is no code path by
 * which a retriever can surface another user's memory.
 */

import type {
  QueryFilters,
  RetrievalOutput,
  RetrieverId,
  RetrievalStep,
  SearchPlan,
} from "@/types/query";

export interface RetrievalBudget {
  /** Ceiling on results this retriever may contribute. */
  maxResults: number;
}

export interface RetrievalInput {
  /** The requesting user — every read is scoped by it. */
  userId: string;
  /**
   * The question in the user's own words. Retrievers that need the
   * raw phrasing (semantic embeds it; keyword probes it) read it
   * here — the plan carries structure, never the verbatim text.
   */
  query: string;
  /** The plan this step belongs to (filters, scope — never implementations). */
  plan: SearchPlan;
  /** The step this retriever is executing. */
  step: RetrievalStep;
  budget: RetrievalBudget;
  filters: QueryFilters;
  /**
   * Evidence from earlier steps in the same run: memory ids that are
   * already candidates and entity ids that resolved. The graph
   * retriever expands from these; other retrievers may ignore them.
   */
  seeds: { memoryIds: string[]; entityIds: string[] };
}

export type { RetrievalOutput };

export interface Retriever {
  readonly id: RetrieverId;
  retrieve(input: RetrievalInput): Promise<RetrievalOutput>;
}

/** Statuses a candidate memory may have, from the plan's filters. */
export function statusAllowed(filters: QueryFilters, status: string): boolean {
  return (filters.statuses as string[]).includes(status);
}

/** Text containment used by keyword scoring — case-folded, script-preserving. */
export function containsTerm(haystack: string, term: string): boolean {
  return haystack.toLowerCase().includes(term.toLowerCase());
}
