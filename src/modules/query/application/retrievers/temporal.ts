/**
 * TemporalRetriever — memories that live in the asked-about time.
 *
 * Reads the plan's resolved windows through the memory module's
 * windowed query: an event date (`rememberedAt`) when the memory has
 * one, the kept-date as an honest proxy when it does not. Score 1.0 —
 * being inside the window IS the evidence; ranking weighs it per
 * intent. Uncertain windows still search (an approximate window is
 * useful) but say so in the reason, so nothing pretends precision.
 */

import { listMemoriesInWindow } from "@/modules/memory";
import type { RetrievalResult } from "@/types/query";
import type { Retriever, RetrievalInput, RetrievalOutput } from "../retrieval-types";
import { statusAllowed } from "../retrieval-types";

export class TemporalRetriever implements Retriever {
  readonly id = "temporal" as const;

  async retrieve(input: RetrievalInput): Promise<RetrievalOutput> {
    if (input.step.kind !== "temporal") return { results: [] };

    const results: RetrievalResult[] = [];
    const seen = new Set<string>();

    for (const window of input.step.config.windows) {
      if (!window.from && !window.to) continue;
      const inWindow = await listMemoriesInWindow(
        input.userId,
        {
          from: window.from ? new Date(window.from) : new Date(0),
          to: window.to ? new Date(window.to) : new Date("9999-12-31"),
        },
        { limit: input.budget.maxResults * 2 }
      );

      for (const memory of inWindow) {
        if (!statusAllowed(input.filters, memory.status)) continue;
        if (seen.has(memory.id)) continue;
        seen.add(memory.id);
        results.push({
          memoryId: memory.id,
          source: this.id,
          score: 1,
          matchedEntityIds: [],
          matchedTerms: [],
          reason: window.uncertain
            ? "falls in the approximate time you asked about"
            : "falls in the time you asked about",
        });
      }
    }

    return { results: results.slice(0, input.budget.maxResults) };
  }
}
