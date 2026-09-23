/**
 * Deterministic ranking — "relevance to this query", nothing else.
 *
 * Every signal is normalized 0..1, weighted by the plan's intent
 * (config/query.ts carries the weights and their rationale), and
 * summed. The score means how well this memory answers THIS question
 * — it never claims the memory's importance in the user's life.
 *
 * No AI call: ranking is pure arithmetic over provenance, so it is
 * reproducible, explainable, and free. Tie-breakers make the order
 * total and stable: source count, then importance, then recency, then
 * id — the same input always produces the same order.
 */

import { queryConfig } from "@/config/query";
import type { MergedCandidate, QueryIntent } from "@/types/query";

export interface RankingSignals {
  entity: number;
  keyword: number;
  /** Cosine similarity from the semantic retriever (0 when absent — never faked). */
  semantic: number;
  temporal: number;
  graph: number;
  importance: number;
  recency: number;
  sourceCount: number;
}

/** One candidate with everything ranking needs — assembled per memory. */
export interface RankedInput {
  candidate: MergedCandidate;
  /** 0..1 temporal fit: 1 inside the asked-about window, 0 outside/none. */
  temporal: number;
  /** The memory's stored importance (0..1 proposal). */
  importance: number;
  /** When the memory was kept (recency anchor). */
  createdAt: Date;
  /** When the remembered thing happened, when known (recency anchor). */
  rememberedAt: Date | null;
}

/** A ranked candidate: relevance filled in, sorted best-first by the ranker. */
export interface RankedCandidate {
  candidate: MergedCandidate;
  temporal: number;
  relevance: number;
}

const SOURCE_COUNT_STEP = 0.34; // 2 sources ≈ 0.34, 3+ ≈ capped 1

/**
 * Rank candidates best-first. Bounded by the caller, which applies the
 * final-memory budget. Deterministic: same input, same order.
 */
export function rankCandidates(candidates: RankedInput[], intent: QueryIntent): RankedCandidate[] {
  const weights = queryConfig.ranking.weights[intent] ?? queryConfig.ranking.weights.find;
  const now = new Date();

  const scored = candidates.map((item) => {
    const { candidate } = item;
    const signals: RankingSignals = {
      entity: clamp01(candidate.scores.entity ?? 0),
      keyword: clamp01(candidate.scores.keyword ?? 0),
      // Absent (embeddings deferred, or the step didn't run) ⇒ 0 — the
      // semantic weight then contributes nothing. There is no path
      // where a semantic score is invented to fill this slot.
      semantic: clamp01(candidate.scores.semantic ?? 0),
      temporal: clamp01(item.temporal),
      graph: candidate.minGraphDistance !== undefined ? 1 / (1 + candidate.minGraphDistance) : 0,
      importance: clamp01(item.importance),
      recency: recencyScore(item.rememberedAt ?? item.createdAt, now),
      sourceCount: clamp01((candidate.sources.length - 1) * SOURCE_COUNT_STEP),
    };

    let relevance = 0;
    for (const [signal, weight] of Object.entries(weights)) {
      relevance += (signals[signal as keyof RankingSignals] ?? 0) * weight;
    }
    relevance = clamp01(relevance);

    return { candidate: item.candidate, temporal: item.temporal, relevance, signals };
  });

  scored.sort((a, b) => {
    if (b.relevance !== a.relevance) return b.relevance - a.relevance;
    if (b.candidate.sources.length !== a.candidate.sources.length) {
      return b.candidate.sources.length - a.candidate.sources.length;
    }
    if (b.signals.importance !== a.signals.importance) {
      return b.signals.importance - a.signals.importance;
    }
    if (b.signals.recency !== a.signals.recency) return b.signals.recency - a.signals.recency;
    return a.candidate.memoryId.localeCompare(b.candidate.memoryId); // total, stable
  });

  return scored.map(({ candidate, temporal, relevance }) => ({ candidate, temporal, relevance }));
}

function recencyScore(date: Date, now: Date): number {
  const ageDays = Math.max(0, (now.getTime() - date.getTime()) / (24 * 60 * 60 * 1000));
  const halfLife = queryConfig.ranking.recencyHalfLifeDays;
  return Math.pow(0.5, ageDays / halfLife);
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
