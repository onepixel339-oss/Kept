/**
 * The memory processing pipeline — the Phase 3 spine.
 *
 *   USER INPUT (already saved as a real memory by the API)
 *     → gather bounded context (retrieval for processing)
 *     → analyzeMemory  → validate (zod) → candidate structure
 *     → resolve entities (deterministic-first, ambiguity preserved)
 *     → compareMemories → validate → filter to what was actually shown
 *     → decision engine (deterministic rules on the evidence)
 *     → apply approved changes through module public APIs
 *     → record provenance (memory_analyses)
 *     → embedding attempt (honestly deferred in this environment)
 *     → processing state: ready | failed
 *
 * Guarantees (binding):
 *  - The raw memory is saved BEFORE any of this runs, and a failure
 *    anywhere below leaves it saved with processing_status = failed.
 *  - The AI never sees the database and never writes anything. The
 *    only writes happen through memory/entity public APIs.
 *  - The model can only reference ids that were in its context;
 *    references to anything else are discarded before deciding.
 *  - Retries are idempotent: no duplicate memories, versions,
 *    relations, or links.
 */

import { getAiGateway, type AiGateway, type EmbeddingRequest, type MemoryIntelligenceProvider, type ProviderResult } from "@/lib/ai";
import type { Memory } from "@/types/memory";
import type { DecisionAction } from "@/types/processing";
import {
  applyMemoryEnrichment,
  claimMemoryForProcessing,
  findMemory,
  markMemoryProcessingFailed,
  markMemoryProcessingReady,
} from "@/modules/memory";
import {
  createEntity,
  findEntitiesByIds,
  findEntityCandidatesByName,
  getEntityMemories,
  listEntityIdsForMemory,
} from "@/modules/entity";
import {
  analysisProposalSchema,
  comparisonProposalSchema,
  parseProposal,
  type AnalysisProposal,
  type ComparisonProposal,
} from "../domain/ai-schemas";
import { decide, type Corroboration, type Decision } from "../domain/decision-engine";
import { resolveEntity } from "../domain/entity-resolution";
import { countAttempts, createAnalysis } from "../infrastructure/analysis-repository";
import {
  extractKeywords,
  gatherProcessingContext,
  keywordOverlap,
  toAnalysisContextMemory,
} from "./retrieval";
import { buildEmbeddingText, representationFromMemory } from "../domain/embedding-representation";
import {
  applyDecision,
  serializeApplied,
  type ResolutionWithProposal,
} from "./decision-applier";

/** Minimal AI surface the pipeline needs — satisfied by the gateway or a test fixture. */
export interface PipelineAi {
  providerId: string;
  analyzeMemory(request: Parameters<AiGateway["analyzeMemory"]>[0]): Promise<ProviderResult>;
  compareMemories(request: Parameters<AiGateway["compareMemories"]>[0]): Promise<ProviderResult>;
  embed(request: EmbeddingRequest): Promise<Awaited<ReturnType<AiGateway["embed"]>>>;
}

/** Adapt a bare provider into the pipeline's AI surface (used by tests). */
export function pipelineAiFromProvider(provider: MemoryIntelligenceProvider): PipelineAi {
  return {
    providerId: provider.id,
    analyzeMemory: (request) =>
      provider.analyzeMemory(request).then((raw) => ({ raw, provider: provider.id })),
    compareMemories: (request) =>
      provider.compareMemories(request).then((raw) => ({ raw, provider: provider.id })),
    embed: (request) =>
      provider.embed
        ? provider.embed(request)
        : Promise.resolve({ available: false as const, reason: "This provider cannot embed." }),
  };
}

/** In-process guard against double runs of the same memory. */
const activeRuns = new Set<string>();

export interface ProcessOptions {
  /** Inject an AI provider (tests use fixtures; production uses the gateway). */
  provider?: MemoryIntelligenceProvider;
}

export interface ProcessResult {
  memoryId: string;
  outcome: "ready" | "failed" | "skipped";
  decision: DecisionAction | null;
  reason: string | null;
}

function serverTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function currentDateForZone(): string {
  // The server's "today" in its own zone — the pipeline runs on the
  // server, and the phase spec asks for the current date + timezone.
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: serverTimezone(),
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/** Stable, human-safe failure text — never raw provider or DB internals. */
function safeFailureReason(error: unknown): string {
  if (error instanceof Error) {
    if (error.message.includes("empty response")) {
      return "The analysis service returned nothing useful.";
    }
    if (error.message.includes("not available")) {
      return "The analysis service is not configured.";
    }
  }
  return "Processing could not finish.";
}

/**
 * Process one already-saved memory. The caller must have loaded it
 * through an owned path (the API route did; tests create it directly).
 */
export async function processMemory(
  memory: Memory,
  options: ProcessOptions = {}
): Promise<ProcessResult> {
  // Claim atomically: another trigger may already be running.
  const claimed = await claimMemoryForProcessing(memory.id);
  if (!claimed || activeRuns.has(memory.id)) {
    return {
      memoryId: memory.id,
      outcome: "skipped",
      decision: null,
      reason: "already-processing",
    };
  }
  activeRuns.add(memory.id);

  const userId = claimed.userId;
  const attempt = (await countAttempts(memory.id)) + 1;
  const ai: PipelineAi = options.provider ? pipelineAiFromProvider(options.provider) : getAiGateway();

  try {
    /* ——— 1. Retrieval for processing: bounded, user-scoped, self-excluded. ——— */
    const context = await gatherProcessingContext(userId, claimed.originalContent, [], claimed.id);

    /* ——— 2. Analysis (validated or safely rejected). ——— */
    let analysisResult: AnalysisProposal;
    try {
      const analysis = await ai.analyzeMemory({
        content: claimed.originalContent,
        currentDate: currentDateForZone(),
        timezone: serverTimezone(),
        context: {
          memories: context.memories.map(toAnalysisContextMemory),
          entities: context.entities,
        },
      });
      const parsed = parseProposal(analysis.raw, analysisProposalSchema);
      if (!parsed.ok) {
        await recordFailure(userId, claimed, attempt, ai.providerId, parsed.rejection);
        return { memoryId: memory.id, outcome: "failed", decision: null, reason: "invalid-analysis" };
      }
      analysisResult = parsed.value;
    } catch (error) {
      await recordFailure(userId, claimed, attempt, ai.providerId, null, safeFailureReason(error));
      return { memoryId: memory.id, outcome: "failed", decision: null, reason: "analysis-failed" };
    }

    const candidate = analysisResult.candidate;

    /* ——— 3. Entity candidate pool + full context (deterministic). ——— */
    const proposed = candidate.entities.map((entity) => ({ type: entity.type, name: entity.name }));
    const contextWithEntities =
      proposed.length > 0
        ? await gatherProcessingContext(userId, claimed.originalContent, proposed, claimed.id)
        : context;

    /* ——— 4. Comparison (validated or safely rejected). ——— */
    let comparisonResult: ComparisonProposal;
    try {
      const comparison = await ai.compareMemories({
        content: claimed.originalContent,
        candidate: analysisResult,
        existingMemories: contextWithEntities.memories.map(toAnalysisContextMemory),
        existingEntities: contextWithEntities.entities,
      });
      const parsed = parseProposal(comparison.raw, comparisonProposalSchema);
      if (!parsed.ok) {
        await recordFailure(userId, claimed, attempt, ai.providerId, parsed.rejection);
        return { memoryId: memory.id, outcome: "failed", decision: null, reason: "invalid-comparison" };
      }
      comparisonResult = parsed.value;
    } catch (error) {
      await recordFailure(userId, claimed, attempt, ai.providerId, null, safeFailureReason(error));
      return { memoryId: memory.id, outcome: "failed", decision: null, reason: "comparison-failed" };
    }

    /* ——— 5. Corroboration: deterministic signals, no AI involved. ——— */
    const candidateMemoryIds = new Set(contextWithEntities.memories.map((m) => m.id));
    const incomingKeywords = extractKeywords(claimed.originalContent);

    // Which user entities touch each candidate memory (shared-entity signal).
    const entityToMemories = new Map<string, string[]>();
    for (const entity of contextWithEntities.entities) {
      const links = await getEntityMemories(userId, entity.id);
      entityToMemories.set(
        entity.id,
        links.map((link) => link.memoryId)
      );
    }

    const sharedEntityIds: Record<string, string[]> = {};
    const keywordOverlaps: Record<string, number> = {};
    for (const candidateMemory of contextWithEntities.memories) {
      const shared: string[] = [];
      for (const [entityId, memoryIds] of entityToMemories) {
        if (memoryIds.includes(candidateMemory.id)) shared.push(entityId);
      }
      sharedEntityIds[candidateMemory.id] = shared;
      keywordOverlaps[candidateMemory.id] = keywordOverlap(incomingKeywords, candidateMemory.keywords);
    }

    const corroboration: Corroboration = { sharedEntityIds, keywordOverlap: keywordOverlaps };

    /* ——— 6. Decision: deterministic rules on filtered evidence. ——— */
    const decision: Decision = decide({
      analysis: analysisResult,
      comparison: comparisonResult,
      corroboration,
      validMemoryIds: candidateMemoryIds,
      selfMemoryId: claimed.id,
    });

    /* ——— 7. Entity resolution: deterministic-first, ambiguity kept. ——— */
    const resolutions: ResolutionWithProposal[] = [];
    for (const entityProposal of candidate.entities) {
      const resolution = await resolveEntity(userId, entityProposal, {
        findEntityCandidatesByName,
        createEntity,
      });
      resolutions.push({ ...resolution, proposal: entityProposal });
    }

    /* ——— 8. Apply approved changes (module public APIs only). ——— */
    const applied = await applyDecision(claimed, candidate, decision, resolutions);

    /* ——— 9. Provenance record: validated proposals + decision + result. ——— */
    await createAnalysis({
      memoryId: claimed.id,
      userId,
      attempt,
      status: "succeeded",
      decision: decision.action,
      provider: ai.providerId,
      analysisJson: JSON.stringify(analysisResult),
      comparisonJson: JSON.stringify(comparisonResult),
      decisionJson: JSON.stringify({
        decision: {
          action: decision.action,
          targetMemoryId: decision.targetMemoryId,
          rationale: decision.rationale,
          links: decision.links,
          entityRelations: decision.entityRelations,
          trace: decision.trace,
        },
        applied: JSON.parse(serializeApplied(applied)),
      }),
      errorReason: null,
    });

    /* ——— 10. Embedding: honest attempt, deferred in this environment. ——— */
    const linkedEntityIds = await listEntityIdsForMemory(userId, claimed.id);
    const linkedEntities = linkedEntityIds.length > 0 ? await findEntitiesByIds(userId, linkedEntityIds) : [];
    await attemptEmbedding(
      ai,
      userId,
      claimed.id,
      linkedEntities.map((entity) => entity.name)
    );

    await markMemoryProcessingReady(userId, claimed.id);
    return {
      memoryId: memory.id,
      outcome: "ready",
      decision: decision.action,
      reason: decision.rationale,
    };
  } catch (error) {
    // Log for the operator; surface only a safe reason to the product.
    // The full error class/message is persisted to the provenance table
    // (server-side debug data, never exposed through the API).
    console.error("[intelligence] unexpected pipeline error:", error);
    // Anything unexpected: the memory stays saved, processing failed.
    const reason = safeFailureReason(error);
    await markMemoryProcessingFailed(userId, memory.id, reason).catch(() => undefined);
    await createAnalysis({
      memoryId: memory.id,
      userId,
      attempt,
      status: "failed",
      decision: null,
      provider: ai.providerId,
      analysisJson: null,
      comparisonJson: null,
      decisionJson: JSON.stringify({
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      }),
      errorReason: reason,
    }).catch(() => undefined);
    return { memoryId: memory.id, outcome: "failed", decision: null, reason: "unexpected-error" };
  } finally {
    activeRuns.delete(memory.id);
  }
}

/**
 * Try to embed the memory's canonical representation; every honest
 * outcome is acceptable, none fails processing (Phase 8 §5). The
 * vector stored is exactly the provider's response — with its
 * (model, version) identity, so retries reuse the same logical row.
 * Nothing here ever fabricates a vector: when the provider cannot
 * embed, the memory is marked `deferred` and remains fully usable.
 */
async function attemptEmbedding(
  ai: PipelineAi,
  userId: string,
  memoryId: string,
  entityNames: string[],
): Promise<void> {
  const startedAt = Date.now();
  try {
    // The representation is built from the POST-processing state —
    // the title/summary/entities the pipeline just applied — never
    // from stale pre-processing data.
    const current = await findMemory(userId, memoryId);
    if (!current) return; // vanished mid-run — nothing to represent, nothing to store
    const text = buildEmbeddingText(representationFromMemory(current, entityNames));

    const embedding = await ai.embed({ text, purpose: "memory", memoryId });
    if (embedding.available) {
      const repository = getAiGateway().embeddings();
      if (repository.availability === "available") {
        await repository.store(memoryId, embedding.vector, {
          model: embedding.model,
          version: embedding.version,
          dimensions: embedding.dimensions,
        });
        await applyMemoryEnrichment(userId, memoryId, { embeddingStatus: "ready" });
        // Observability (Phase 8 §27): duration + identity only — never memory text.
        console.info(
          `[embeddings] stored memory=${memoryId} model=${embedding.model} version=${embedding.version} dims=${embedding.dimensions} ms=${Date.now() - startedAt}`
        );
        return;
      }
    }
    await applyMemoryEnrichment(userId, memoryId, { embeddingStatus: "deferred" });
    console.info(
      `[embeddings] deferred memory=${memoryId} ms=${Date.now() - startedAt} reason=${embedding.available ? "no-repository" : "provider-unavailable"}`
    );
  } catch {
    // Embedding trouble never fails processing — the memory is ready.
    await applyMemoryEnrichment(userId, memoryId, { embeddingStatus: "failed" }).catch(
      () => undefined
    );
    console.info(`[embeddings] failed memory=${memoryId} ms=${Date.now() - startedAt}`);
  }
}

/** Record a rejected (unparseable/invalid) or failed attempt, and mark the memory. */
async function recordFailure(
  userId: string,
  memory: Memory,
  attempt: number,
  providerId: string,
  rejection: { kind: string; detail: string } | null,
  failureReason?: string
): Promise<void> {
  const status = rejection ? "rejected" : "failed";
  const reason = rejection
    ? `The proposal could not be accepted (${rejection.kind}).`
    : failureReason ?? "Processing could not finish.";

  await createAnalysis({
    memoryId: memory.id,
    userId,
    attempt,
    status,
    decision: null,
    provider: providerId,
    analysisJson: null,
    comparisonJson: null,
    decisionJson: rejection ? JSON.stringify({ rejection }) : null,
    errorReason: reason,
  }).catch(() => undefined);

  await markMemoryProcessingFailed(userId, memory.id, reason).catch(() => undefined);
}
