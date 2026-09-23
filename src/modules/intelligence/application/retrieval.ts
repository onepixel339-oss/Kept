/**
 * Retrieval for processing — a small, bounded window of context.
 *
 * This is NOT the Phase 4 retrieval engine and deliberately not smart:
 * keyword search over the user's own memories (title + content), the
 * most recent memories, and name-based entity candidates. Everything
 * is scoped to the requesting user, every count is bounded by
 * intelligenceConfig, and the results exist for exactly one purpose —
 * giving the analysis/comparison steps enough context to compare
 * honestly without seeing the whole archive.
 */

import { snippet } from "@/lib/format";
import type { AnalysisContextEntity, AnalysisContextMemory } from "@/lib/ai/intelligence-types";
import type { Entity } from "@/types/entity";
import { intelligenceConfig } from "@/config/intelligence";
import { listMemories } from "@/modules/memory";
import { findEntityCandidatesByName } from "@/modules/entity";

/** Extract the strongest keywords from a memory's text. */
export function extractKeywords(text: string, max = intelligenceConfig.limits.maxKeywords): string[] {
  const stopwords = new Set([
    // English function words
    "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "at", "for",
    "with", "about", "is", "was", "were", "are", "be", "been", "am", "i",
    "my", "me", "we", "our", "you", "your", "he", "she", "it", "they", "them",
    "his", "her", "their", "this", "that", "these", "those", "have", "has",
    "had", "do", "does", "did", "will", "would", "can", "could", "should",
    "just", "very", "really", "so", "if", "then", "than", "as", "not", "no",
    // Arabic high-frequency function words
    "في", "من", "على", "الى", "إلى", "عن", "مع", "هذا", "هذه", "ذلك", "التي",
    "الذي", "كان", "كانت", "قد", "لا", "ما", "ان", "أن", "إن", "اليوم",
  ]);

  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length > 1 && !stopwords.has(word));

  const frequency = new Map<string, number>();
  for (const word of words) {
    frequency.set(word, (frequency.get(word) ?? 0) + 1);
  }

  return [...frequency.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([word]) => word);
}

/** Jaccard overlap between two keyword sets (0..1) — the deterministic echo signal. */
export function keywordOverlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  const intersection = a.filter((word) => setB.has(word)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

export interface CandidateMemoryContext {
  id: string;
  title: string | null;
  snippet: string;
  memoryType: string;
  /** Keywords of the candidate (title + excerpt) — for deterministic corroboration. */
  keywords: string[];
}

export interface ProcessingContext {
  /** Bounded candidate memories (dedup, excludes nothing the user owns). */
  memories: CandidateMemoryContext[];
  /** Bounded existing entities relevant to the proposed names. */
  entities: AnalysisContextEntity[];
  /** The full candidate pool the entity search produced, per proposal. */
  entityCandidates: Array<{ entity: Entity; basis: string }>;
}

/**
 * Gather the bounded context for processing one memory: candidate
 * memories by keyword and by recency, plus entity candidates for each
 * proposed name. All queries are user-scoped and bounded. The memory
 * being processed is always excluded from its own candidates — a
 * memory must never be compared against itself. Corroboration
 * keywords are computed from title + excerpt — a coarse, conservative
 * signal (it can only underestimate overlap, which errs toward CREATE
 * over UPDATE/MERGE, the safe direction).
 */
export async function gatherProcessingContext(
  userId: string,
  content: string,
  proposedEntities: Array<{ type: Entity["type"]; name: string }>,
  excludeMemoryId?: string
): Promise<ProcessingContext> {
  const limits = intelligenceConfig.limits;
  const keywords = extractKeywords(content);
  const searchTerms = keywords.slice(0, limits.maxKeywordTerms);

  // Candidate memories: union of keyword hits and the most recent page,
  // deduplicated, never including the memory itself. The keyword count
  // per memory acts as a simple rank.
  const scores = new Map<string, { score: number }>();
  for (const term of searchTerms) {
    const result = await listMemories(userId, { q: term, page: 1, pageSize: 5 });
    for (const item of result.items) {
      if (item.id === excludeMemoryId) continue;
      scores.set(item.id, { score: (scores.get(item.id)?.score ?? 0) + 1 });
    }
  }

  const recent = await listMemories(userId, { page: 1, pageSize: limits.maxCandidateMemories });
  for (const item of recent.items) {
    if (item.id === excludeMemoryId) continue;
    if (!scores.has(item.id)) {
      scores.set(item.id, { score: 0 });
    }
  }

  // Projections for the whole bounded set (the recency page already
  // carries most; keyword-only hits are fetched here).
  const projections = new Map<string, Awaited<ReturnType<typeof listMemories>>["items"][number]>();
  for (const item of recent.items) {
    if (item.id === excludeMemoryId) continue;
    projections.set(item.id, item);
  }
  if (projections.size < scores.size) {
    for (const term of searchTerms) {
      const result = await listMemories(userId, { q: term, page: 1, pageSize: 5 });
      for (const item of result.items) {
        if (item.id === excludeMemoryId) continue;
        projections.set(item.id, item);
      }
    }
  }

  const memories: CandidateMemoryContext[] = [...scores.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, limits.maxCandidateMemories)
    .flatMap(([id]) => {
      const item = projections.get(id);
      if (!item) return [];
      return [
        {
          id: item.id,
          title: item.title,
          snippet: item.snippet,
          memoryType: item.memoryType,
          keywords: extractKeywords(`${item.title ?? ""} ${item.snippet}`),
        },
      ];
    });

  // Entity candidates for each proposed name (bounded per proposal).
  const entityCandidates: ProcessingContext["entityCandidates"] = [];
  const seenEntities = new Set<string>();
  for (const proposal of proposedEntities) {
    const found = await findEntityCandidatesByName(userId, {
      type: proposal.type,
      name: proposal.name,
      limit: limits.maxCandidateEntitiesPerType,
    });
    for (const candidate of found) {
      if (seenEntities.has(candidate.entity.id)) continue;
      seenEntities.add(candidate.entity.id);
      entityCandidates.push(candidate);
    }
  }

  const entities: AnalysisContextEntity[] = entityCandidates
    .slice(0, limits.maxCandidateEntitiesPerType)
    .map(({ entity }) => ({ id: entity.id, type: entity.type, name: entity.name }));

  return { memories, entities, entityCandidates };
}

/** Project a candidate memory into the plain context shape the gateway sends. */
export function toAnalysisContextMemory(memory: CandidateMemoryContext): AnalysisContextMemory {
  return {
    id: memory.id,
    title: memory.title,
    snippet: memory.snippet,
    memoryType: memory.memoryType,
  };
}

export { snippet };
