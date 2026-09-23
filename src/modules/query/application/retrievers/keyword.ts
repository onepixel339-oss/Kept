/**
 * KeywordRetriever — the user's words against the user's own text.
 *
 * Each probe term is searched over title, summary, and original
 * content via the memory module's list search; the full rows are then
 * fetched once (batched) and scored by how many distinct terms they
 * match, with a small bonus when a term hits the title. A full-phrase
 * probe runs first — an exact echo of the user's words is the
 * strongest keyword evidence there is.
 *
 * HONEST LIMITATION (documented, not hidden): SQLite's LIKE is
 * case-insensitive for ASCII only and has no stemming, so Arabic
 * matches on exact substrings and "running" will not match "ran".
 * No advanced linguistic behavior is claimed or faked.
 */

import { getMemoriesByIds, listMemories } from "@/modules/memory";
import type { RetrievalResult } from "@/types/query";
import type { Retriever, RetrievalInput, RetrievalOutput } from "../retrieval-types";
import { containsTerm, statusAllowed } from "../retrieval-types";

export class KeywordRetriever implements Retriever {
  readonly id = "keyword" as const;

  async retrieve(input: RetrievalInput): Promise<RetrievalOutput> {
    if (input.step.kind !== "keyword") return { results: [] };
    const terms = input.step.config.terms;
    if (terms.length === 0) return { results: [] };

    const allIds = new Set<string>();

    // Probe each term through the memory module's own search (title +
    // summary + content). One bounded read per term.
    for (const term of terms) {
      const page = await listMemories(input.userId, { q: term, page: 1, pageSize: input.budget.maxResults });
      for (const item of page.items) allIds.add(item.id);
    }

    if (allIds.size === 0) return { results: [] };

    // One batched fetch for scoring against full text.
    const memories = await getMemoriesByIds(input.userId, [...allIds]);
    const results: RetrievalResult[] = [];

    for (const memory of memories) {
      if (!statusAllowed(input.filters, memory.status)) continue;
      const haystacks = [memory.title ?? "", memory.summary ?? "", memory.originalContent];
      const matched = terms.filter((term) => haystacks.some((text) => containsTerm(text, term)));
      if (matched.length === 0) continue;

      const titleHit = matched.some((term) => containsTerm(memory.title ?? "", term));
      const base = matched.length / terms.length;
      const score = Math.min(1, base + (titleHit ? 0.15 : 0));

      results.push({
        memoryId: memory.id,
        source: this.id,
        score,
        matchedEntityIds: [],
        matchedTerms: matched,
        reason: `mentions ${matched.map((term) => `“${term}”`).join(", ")}`,
      });
    }

    results.sort((a, b) => b.score - a.score);
    return { results: results.slice(0, input.budget.maxResults) };
  }
}
