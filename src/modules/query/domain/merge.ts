/**
 * Candidate merging — one memory, one candidate, full provenance.
 *
 * Different retrievers surface the same memory; the merge unions them
 * into a single candidate that keeps every source, every score, every
 * piece of matched evidence. Duplicates never reach ranking or the
 * context builder. Pure and deterministic.
 */

import type { MergedCandidate, RetrievalResult, RetrieverId } from "@/types/query";

export function mergeCandidates(results: RetrievalResult[]): MergedCandidate[] {
  const byMemory = new Map<string, MergedCandidate>();

  for (const result of results) {
    const existing = byMemory.get(result.memoryId);
    if (!existing) {
      const scores: Partial<Record<RetrieverId, number>> = {};
      scores[result.source] = result.score;
      byMemory.set(result.memoryId, {
        memoryId: result.memoryId,
        sources: [result.source],
        scores,
        matchedEntityIds: [...result.matchedEntityIds],
        matchedTerms: [...result.matchedTerms],
        minGraphDistance: result.graphDistance,
        relevance: 0,
      });
      continue;
    }

    if (!existing.sources.includes(result.source)) {
      existing.sources.push(result.source);
    }
    const previousBest = existing.scores[result.source];
    if (previousBest === undefined || result.score > previousBest) {
      existing.scores[result.source] = result.score;
    }
    for (const entityId of result.matchedEntityIds) {
      if (!existing.matchedEntityIds.includes(entityId)) existing.matchedEntityIds.push(entityId);
    }
    for (const term of result.matchedTerms) {
      if (!existing.matchedTerms.includes(term)) existing.matchedTerms.push(term);
    }
    if (result.graphDistance !== undefined) {
      existing.minGraphDistance =
        existing.minGraphDistance === undefined
          ? result.graphDistance
          : Math.min(existing.minGraphDistance, result.graphDistance);
    }
  }

  return [...byMemory.values()];
}
