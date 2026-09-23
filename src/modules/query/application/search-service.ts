/**
 * Search service — grouped, honest search that never needs an LLM.
 *
 * The deterministic pipeline end to end: the question is understood
 * by the fallback (deterministic) path — words, the user's own entity
 * names, and resolvable time expressions only — then planned,
 * retrieved, merged, and ranked by the same engine the Ask pipeline
 * uses. Results group into memories, entities, and topics, sized for
 * a page, not a dataset (spec §18: small and useful).
 *
 * This is also the proof that retrieval does not depend on AI or
 * embeddings: remove the model entirely and search still works.
 */

import { queryConfig } from "@/config/query";
import { snippet } from "@/lib/format";
import type { Memory } from "@/types/memory";
import type { RetrievalRunInfo } from "@/types/query";
import { buildFallbackUnderstanding } from "../domain/fallback-understanding";
import { runRetrieval, type OrchestratorOptions } from "./orchestrator";
import { semanticAvailable } from "./retrievers/semantic";
import { findEntitiesByIds } from "@/modules/entity";

export interface SearchSpaceResult {
  query: string;
  memories: Array<{
    memoryId: string;
    title: string | null;
    snippet: string;
    memoryType: string;
    rememberedAt: string | null;
    createdAt: string;
    relevance: number;
    sources: string[];
    matchedTerms: string[];
    reason: string;
  }>;
  entities: Array<{
    entityId: string;
    name: string;
    type: string;
    basis: string;
  }>;
  topics: Array<{
    entityId: string;
    name: string;
  }>;
  semantic: RetrievalRunInfo["semantic"];
  planIterations: number;
  failures: Array<{ retriever: string; reason: string }>;
  time: { from: string | null; to: string | null; uncertain: boolean; expression: string | null };
}

export async function searchMemorySpace(
  userId: string,
  query: string,
  options: OrchestratorOptions = {}
): Promise<SearchSpaceResult> {
  const trimmed = query.trim();
  const now = new Date();

  // Deterministic understanding — never an AI call (spec §18).
  const understanding = await buildFallbackUnderstanding(trimmed, userId, {
    currentDate: now,
    timezone: "UTC",
    scope: "global",
  });

  const outcome = await runRetrieval(userId, trimmed, understanding, {
    ...options,
    semantic: semanticAvailable() ? "available" : "deferred",
  });

  const limits = queryConfig.search;

  // Entity rows for the resolved ids (bounded, ownership-scoped).
  const entityIds = outcome.entities?.map((entity) => entity.entityId) ?? [];
  const entityRows = await findEntitiesByIds(userId, entityIds);
  const entityById = new Map(entityRows.map((entity) => [entity.id, entity]));

  const entities = (outcome.entities ?? [])
    .filter((entity) => entityById.has(entity.entityId) && entityById.get(entity.entityId)!.type !== "topic")
    .slice(0, limits.maxEntities)
    .map((entity) => ({
      entityId: entity.entityId,
      name: entityById.get(entity.entityId)!.name,
      type: entityById.get(entity.entityId)!.type,
      basis: entity.basis,
    }));

  const topics = (outcome.entities ?? [])
    .filter((entity) => entityById.get(entity.entityId)?.type === "topic")
    .slice(0, limits.maxTopics)
    .map((entity) => ({
      entityId: entity.entityId,
      name: entityById.get(entity.entityId)!.name,
    }));

  const memories = outcome.candidates.slice(0, limits.maxMemories).map(({ candidate, relevance, memory }) =>
    projectMemory(memory, candidate.memoryId, candidate.sources, candidate.matchedTerms, relevance, candidate.minGraphDistance, candidate.matchedEntityIds.length)
  );

  return {
    query: trimmed,
    memories,
    entities,
    topics,
    semantic: outcome.semantic,
    planIterations: outcome.plan.iteration,
    failures: outcome.failures,
    time: {
      from: understanding.time.from,
      to: understanding.time.to,
      uncertain: understanding.time.uncertain,
      expression: understanding.time.expression,
    },
  };
}

function projectMemory(
  memory: Memory,
  memoryId: string,
  sources: string[],
  matchedTerms: string[],
  relevance: number,
  graphDistance: number | undefined,
  matchedEntityCount: number
): SearchSpaceResult["memories"][number] {
  const parts: string[] = [];
  if (matchedEntityCount > 0) parts.push("involves your people & things");
  if (matchedTerms.length > 0) parts.push(`mentions “${matchedTerms.slice(0, 3).join("’, ‘")}”`);
  if (graphDistance !== undefined) {
    parts.push(graphDistance === 1 ? "directly connected" : `${graphDistance} steps away`);
  }
  if (parts.length === 0) parts.push("surfaced by search");

  return {
    memoryId,
    title: memory.title,
    snippet: snippet(memory.originalContent),
    memoryType: memory.memoryType,
    rememberedAt: memory.rememberedAt ? memory.rememberedAt.toISOString() : null,
    createdAt: memory.createdAt.toISOString(),
    relevance,
    sources,
    matchedTerms,
    reason: parts.join("; "),
  };
}
