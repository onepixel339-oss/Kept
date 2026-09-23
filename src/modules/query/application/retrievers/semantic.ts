/**
 * SemanticRetriever — ACTIVE code, honestly gated.
 *
 * Phase 8 turns the old deferral stub into the real retriever the
 * spec describes (§8): embed the question, search the user's stored
 * memory vectors, return best-first candidates with their cosine
 * score and provenance. What keeps this honest is the GATE, not a
 * stub:
 *
 *  - the provider must genuinely embed (`embeds: true` + embed()).
 *    In this environment the z.ai SDK has NO embedding API, so the
 *    gate is closed and production never reaches the search path —
 *    the run reports `semantic: "deferred"` exactly as before;
 *  - the query embedding is TRANSIENT (§9): one embed call per
 *    retrieval (§13), never persisted, never stored as a memory;
 *  - stored vectors come only from the repository seam — real
 *    provider output in production, deterministic fixtures in tests.
 *    Nothing in this file can invent a vector or a score;
 *  - ownership is structural: the repository joins through the
 *    memories table's user_id, then every candidate is re-read
 *    through the memory module's owned path before it becomes a
 *    result (same discipline as every other retriever).
 *
 * When a capable provider (or PostgreSQL/pgvector) arrives, this
 * retriever starts running without a single change here — the
 * planner's availability check simply opens.
 */

import { queryConfig } from "@/config/query";
import { getAiGateway, type AiGateway } from "@/lib/ai";
import { getMemoriesByIds } from "@/modules/memory";
import type { RetrievalResult } from "@/types/query";
import type { Retriever, RetrievalInput, RetrievalOutput } from "../retrieval-types";
import { statusAllowed } from "../retrieval-types";

/** Whether semantic retrieval can genuinely run right now. */
export function semanticAvailable(gateway: AiGateway = getAiGateway()): boolean {
  return gateway.embeddingCapability().ready;
}

/** Test seam: the gateway surface this retriever actually needs. */
export interface SemanticDeps {
  gateway?: AiGateway;
}

export class SemanticRetriever implements Retriever {
  readonly id = "semantic" as const;
  private readonly gateway: AiGateway;

  constructor(deps: SemanticDeps = {}) {
    this.gateway = deps.gateway ?? getAiGateway();
  }

  async retrieve(input: RetrievalInput): Promise<RetrievalOutput> {
    if (input.step.kind !== "semantic") return { results: [] };

    const capability = this.gateway.embeddingCapability();
    if (!capability.ready) {
      return {
        results: [],
        unavailable: {
          reason: !capability.provider
            ? "Semantic retrieval is deferred in this environment — the configured provider cannot generate embeddings. Search continued with the other strategies."
            : "Semantic retrieval is deferred in this environment — no vector storage is available. Search continued with the other strategies.",
        },
      };
    }

    const repository = this.gateway.embeddings();
    if (!repository.search) {
      // Unreachable while the capability gate is honest; kept as a
      // guard so a misconfigured repository fails loudly, not fake.
      return {
        results: [],
        unavailable: { reason: "The embedding repository provides no search." },
      };
    }

    // ——— One transient query embedding (§9, §13) ———
    const queryEmbedding = await this.gateway.embed({
      text: input.query,
      purpose: "query",
    });
    if (!queryEmbedding.available) {
      // The provider claimed capability but failed here — fall back
      // honestly; the other retrievers' results still stand (§14).
      return {
        results: [],
        unavailable: {
          reason: "The query embedding could not be generated. Search continued with the other strategies.",
        },
      };
    }

    // ——— Cosine search over the user's own vectors (ownership joined) ———
    const hits = await repository.search(
      input.userId,
      queryEmbedding.vector,
      {
        model: queryEmbedding.model,
        version: queryEmbedding.version,
        dimensions: queryEmbedding.dimensions,
      },
      queryConfig.budgets.maxSemanticResults
    );
    if (hits.length === 0) return { results: [] };

    // ——— Re-read every candidate through the owned path + filters ———
    const memories = await getMemoriesByIds(input.userId, hits.map((hit) => hit.memoryId));
    const memoryById = new Map(memories.map((memory) => [memory.id, memory]));

    const results: RetrievalResult[] = [];
    for (const hit of hits) {
      if (hit.score < queryConfig.budgets.minSemanticScore) break; // sorted best-first
      const memory = memoryById.get(hit.memoryId);
      if (!memory) continue; // deleted mid-run — never a candidate
      if (!statusAllowed(input.filters, memory.status)) continue;
      if (
        input.filters.memoryTypes?.length &&
        !input.filters.memoryTypes.includes(memory.memoryType)
      ) {
        continue;
      }
      results.push({
        memoryId: memory.id,
        source: this.id,
        // Normalized 0..1 for the ranker: real embeddings rarely dip
        // below 0 meaningfully; clamping keeps the scale honest.
        score: Math.max(0, Math.min(1, hit.score)),
        matchedEntityIds: [],
        matchedTerms: [],
        reason: "similar in meaning to your question",
      });
    }

    return { results };
  }
}
