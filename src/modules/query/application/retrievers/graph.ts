/**
 * GraphRetriever — bounded traversal of the user's own graph.
 *
 * Expands from seeds (memories/entities resolved by earlier steps)
 * across the two edge families the data model provides:
 *
 *   memory ↔ entity   (memory_entities links)
 *   node   ↔ node     (relations: memory↔memory, memory↔entity,
 *                      entity↔entity — polymorphic endpoints)
 *
 * Safety rails:
 *  - maximum depth from the plan step (planner-capped at 3)
 *  - maximum distinct nodes expanded (config budget)
 *  - a visited set — cycles terminate, always
 *  - ownership is structural: every adjacency read is user-scoped, so
 *    a cross-user edge is unrepresentable, not merely forbidden
 *
 * Score = 1/distance (direct connection 1.0, two steps 0.5, …).
 * Seeds themselves are NOT emitted — they already came from other
 * retrievers; the graph's job is what they CONNECT to.
 */

import { queryConfig } from "@/config/query";
import { getMemoriesByIds } from "@/modules/memory";
import {
  listEntityIdsForMemories,
  listMemoryIdsForEntities,
  listRelationsTouchingNodes,
} from "@/modules/entity";
import type { RelationNodeType } from "@/types/relation";
import type { RetrievalResult } from "@/types/query";
import type { Retriever, RetrievalInput, RetrievalOutput } from "../retrieval-types";
import { statusAllowed } from "../retrieval-types";

interface GraphNode {
  type: RelationNodeType;
  id: string;
}

function key(node: GraphNode): string {
  return `${node.type}:${node.id}`;
}

export class GraphRetriever implements Retriever {
  readonly id = "graph" as const;

  async retrieve(input: RetrievalInput): Promise<RetrievalOutput> {
    if (input.step.kind !== "graph") return { results: [] };

    const { maxGraphDepth, maxGraphNodes } = queryConfig.budgets;
    const depth = Math.min(input.step.config.depth, maxGraphDepth);
    const nodeCap = maxGraphNodes;

    // Seeds are already candidates from other retrievers — they are
    // marked visited so traversal only ever emits what they CONNECT to.
    const visited = new Set<string>();
    for (const id of input.seeds.memoryIds) visited.add(key({ type: "memory", id }));
    for (const id of input.seeds.entityIds) visited.add(key({ type: "entity", id }));

    let frontier: GraphNode[] = [
      ...input.seeds.memoryIds.map((id): GraphNode => ({ type: "memory", id })),
      ...input.seeds.entityIds.map((id): GraphNode => ({ type: "entity", id })),
    ];

    /** memoryId → the shallowest distance it was reached at. */
    const firstDistance = new Map<string, number>();
    let nodesExpanded = 0;

    for (let currentDepth = 1; currentDepth <= depth && frontier.length > 0; currentDepth++) {
      const nextFrontier: GraphNode[] = [];

      // Batched adjacency for the whole frontier (no N+1 per node).
      const memorySeeds = frontier.filter((node) => node.type === "memory").map((node) => node.id);
      const entitySeeds = frontier.filter((node) => node.type === "entity").map((node) => node.id);

      const memoryToEntities =
        memorySeeds.length > 0
          ? await listEntityIdsForMemories(input.userId, memorySeeds)
          : new Map<string, string[]>();
      const entityToMemories =
        entitySeeds.length > 0
          ? await listMemoryIdsForEntities(input.userId, entitySeeds)
          : new Map<string, string[]>();
      const relations = await listRelationsTouchingNodes(input.userId, frontier, nodeCap * 4);

      for (const node of frontier) {
        if (nodesExpanded >= nodeCap) break; // bounded traversal
        nodesExpanded++;

        const neighbors: GraphNode[] = [];

        if (node.type === "memory") {
          for (const entityId of memoryToEntities.get(node.id) ?? []) {
            neighbors.push({ type: "entity", id: entityId });
          }
        } else {
          for (const memoryId of entityToMemories.get(node.id) ?? []) {
            neighbors.push({ type: "memory", id: memoryId });
          }
        }

        for (const relation of relations) {
          if (relation.sourceType === node.type && relation.sourceId === node.id) {
            neighbors.push({ type: relation.targetType, id: relation.targetId });
          }
          if (relation.targetType === node.type && relation.targetId === node.id) {
            neighbors.push({ type: relation.sourceType, id: relation.sourceId });
          }
        }

        for (const neighbor of neighbors) {
          const neighborKey = key(neighbor);
          if (visited.has(neighborKey)) continue; // cycle protection
          visited.add(neighborKey);
          if (neighbor.type === "memory") {
            if (!firstDistance.has(neighbor.id)) {
              firstDistance.set(neighbor.id, currentDepth);
            }
          }
          nextFrontier.push(neighbor);
        }
      }

      frontier = nextFrontier.slice(0, Math.max(0, nodeCap - nodesExpanded));
    }

    const memoryIds = [...firstDistance.keys()];
    if (memoryIds.length === 0) return { results: [] };

    // One batched, ownership-scoped read for everything discovered.
    const memories = await getMemoriesByIds(input.userId, memoryIds);
    const results: RetrievalResult[] = [];
    for (const memory of memories) {
      if (!statusAllowed(input.filters, memory.status)) continue;
      const distance = firstDistance.get(memory.id) ?? 1;
      results.push({
        memoryId: memory.id,
        source: this.id,
        score: 1 / distance,
        matchedEntityIds: [],
        matchedTerms: [],
        graphDistance: distance,
        reason:
          distance === 1
            ? "directly connected in your graph"
            : `${distance} steps away in your graph`,
      });
    }

    results.sort((a, b) => (a.graphDistance ?? 0) - (b.graphDistance ?? 0));
    return { results: results.slice(0, input.budget.maxResults) };
  }
}
