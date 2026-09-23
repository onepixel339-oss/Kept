/**
 * StructuredRetriever — exact filtering, zero intelligence.
 *
 * Explicit memory ids (a scope-focused question) and memory-type
 * restrictions become direct database reads. No LLM, no scoring
 * subtleties: a memory matching the filter either surfaces (1.0) or
 * does not. Calendar windows are the temporal retriever's job; this
 * retriever only handles exact field filters (spec §4). Ownership is
 * enforced by the memory module's public API.
 */

import { getMemoriesByIds, listMemories } from "@/modules/memory";
import type { RetrievalResult } from "@/types/query";
import type { Retriever, RetrievalInput, RetrievalOutput } from "../retrieval-types";
import { statusAllowed } from "../retrieval-types";

export class StructuredRetriever implements Retriever {
  readonly id = "structured" as const;

  async retrieve(input: RetrievalInput): Promise<RetrievalOutput> {
    if (input.step.kind !== "structured") return { results: [] };
    const results: RetrievalResult[] = [];
    const seen = new Set<string>();

    const add = (memoryId: string, reason: string) => {
      if (seen.has(memoryId)) return;
      seen.add(memoryId);
      results.push({
        memoryId,
        source: this.id,
        score: 1,
        matchedEntityIds: [],
        matchedTerms: [],
        reason,
      });
    };

    // Explicit scope focus: the user is asking ABOUT one memory.
    if (input.step.config.memoryIds?.length) {
      const memories = await getMemoriesByIds(input.userId, input.step.config.memoryIds);
      for (const memory of memories) {
        if (!statusAllowed(input.filters, memory.status)) continue;
        add(memory.id, "the memory you asked about");
      }
    }

    // Memory-type restriction: an exact field filter.
    if (input.step.config.memoryTypes?.length) {
      for (const memoryType of input.step.config.memoryTypes) {
        const page = await listMemories(input.userId, { memoryType, page: 1, pageSize: input.budget.maxResults });
        const full = await getMemoriesByIds(input.userId, page.items.map((item) => item.id));
        for (const memory of full) {
          if (!statusAllowed(input.filters, memory.status)) continue;
          add(memory.id, `kept as a “${memory.memoryType}” memory`);
        }
      }
    }

    return { results: results.slice(0, input.budget.maxResults) };
  }
}
