/**
 * Ask service — the full "ask your memory" pipeline (Phase 5).
 *
 *   question → understand (AI proposal, deterministic fallback)
 *            → plan → retrieve → merge → rank → CONTEXT PACK
 *            → route on the user's EXPLICIT chat intent:
 *
 *     capture ("افتكر إني…")  → Memory Orchestrator entry (createMemory
 *                               via the memory module — the authority);
 *                               processing is scheduled by the route,
 *                               exactly like POST /api/memories
 *     deletion ("احذف…")      → existing deletion flow when the target
 *                               is unambiguous; a clarification when
 *                               it is not. The server performs it —
 *                               never the model.
 *     count ("كام ذكرى؟")     → database count, no model (spec §24)
 *     empty pack              → honest no-evidence line (spec §8)
 *     plain structured find   → retrieval listing, no model (spec §24)
 *     anything else           → grounded reasoning (generate → verify
 *                               → bounded regeneration → conservative)
 *
 * The reasoning model receives ONLY the structured pack — it never
 * retrieves. Whatever the outcome, the assistant message persisted is
 * the final answer plus its provenance — never hidden reasoning.
 *
 * Chat scopes (§20) reuse the same planner and retrievers — scope is
 * an input, not a separate engine.
 */

import { getAiGateway } from "@/lib/ai";
import type {
  ReasoningContextPack,
  UnderstandQueryRequest,
} from "@/lib/ai";
import { listRecentMessages, saveChatMessage } from "@/modules/conversation";
import { listRecentEntities } from "@/modules/entity";
import { listRelationsTouchingNodes } from "@/modules/entity";
import { createMemory, deleteMemory, findMemory, listMemories, listMemoriesInWindow } from "@/modules/memory";
import {
  reasonOverContext,
  reasoningFailedAnswer,
  captureAnswer,
  clarificationAnswer,
  countAnswer,
  deletedAnswer,
  listAnswer,
  noEvidenceAnswer,
  type ReasoningAnswer,
} from "@/modules/reasoning";
import type { QueryScope } from "@/types/query";
import { buildFallbackUnderstanding } from "../domain/fallback-understanding";
import { parseQueryUnderstanding, type QueryUnderstanding } from "../domain/understanding";
import { detectCountQuestion, detectDeletionRequest, detectMemoryCapture } from "../domain/chat-intents";
import { buildContext } from "../domain/context-builder";
import { runRetrieval, type OrchestratorOptions } from "./orchestrator";
import { semanticAvailable } from "./retrievers/semantic";
import type { RelationNodeType } from "@/types/relation";

export interface AskRequest {
  message: string;
  conversationId?: string | null;
  scope?: QueryScope;
  scopeId?: string | null;
}

export interface AskResult {
  conversationId: string;
  /** The validated (or fallback) understanding — inspectable, honest. */
  understanding: {
    intent: QueryUnderstanding["intent"];
    depth: QueryUnderstanding["depth"];
    mentions: QueryUnderstanding["mentions"];
    topics: string[];
    time: QueryUnderstanding["time"];
    needsReasoning: boolean;
    source: "ai" | "fallback";
  };
  context: ReturnType<typeof buildContext>;
  /** The final answer (grounded or honest-deterministic) with provenance. */
  answer: ReasoningAnswer;
  /** The memory mutation the chat performed, when it did (spec §16–18). */
  action?:
    | { kind: "captured"; memoryId: string; title: string | null }
    | { kind: "deleted"; memoryId: string; title: string | null }
    | { kind: "delete_clarification"; candidateMemoryIds: string[] };
}

const MAX_MESSAGE_LENGTH = 4_000;
/** Verbatim excerpt per memory sent to the reasoning model (cost-bounded). */
const REASONING_EXCERPT_LENGTH = 800;
/** Below this relevance a candidate cannot alone justify a deletion. */
const MIN_DELETE_RELEVANCE = 0.5;

export interface AskOptions extends OrchestratorOptions {
  /**
   * Test seam: a stand-in for the gateway's understandQuery (raw JSON
   * text, exactly like a provider returns). Production never sets it;
   * tests never point the real gateway at the network.
   */
  understandingProvider?: (request: UnderstandQueryRequest) => Promise<string>;
  /**
   * Test seam: stand-ins for the reasoning gateway calls (same raw-JSON
   * contract). Production never sets them; tests never reach z.ai.
   */
  answerProvider?: (request: Parameters<ReturnType<typeof getAiGateway>["generateAnswer"]>[0]) => Promise<string>;
  verificationProvider?: (request: Parameters<ReturnType<typeof getAiGateway>["verifyAnswer"]>[0]) => Promise<string>;
}

export async function askMemorySpace(
  userId: string,
  request: AskRequest,
  options: AskOptions = {}
): Promise<AskResult> {
  const message = request.message.trim().slice(0, MAX_MESSAGE_LENGTH);
  const scope = request.scope ?? "global";
  const now = new Date();

  // 1. Bounded conversation context for follow-ups (spec §14).
  let conversationTurns: Array<{ role: "user" | "assistant"; content: string }> = [];
  let conversationId = request.conversationId?.trim() || null;
  if (conversationId) {
    const window = await listRecentMessages(userId, conversationId);
    conversationTurns = window.messages.map((turn) => ({ role: turn.role, content: turn.content }));
  }

  // 2. Understand: AI proposal through the gateway, validated here;
  //    any failure falls back to the deterministic understanding.
  //    The user's known entities travel as bounded context so the
  //    model can PROPOSE cross-language references (المشروع →
  //    "website project") — proposals are validated below; the model
  //    never decides.
  const knownEntityRows = await listRecentEntities(userId, 30);
  const knownEntities = knownEntityRows.map((entity) => ({
    id: entity.id,
    type: entity.type,
    name: entity.name,
  }));

  let understanding: QueryUnderstanding;
  let understandingSource: "ai" | "fallback" = "ai";
  try {
    const understandRequest: UnderstandQueryRequest = {
      message,
      currentDate: now.toISOString(),
      timezone: "UTC",
      scope: { kind: scope, id: request.scopeId ?? null },
      conversation: conversationTurns,
      knownEntities,
    };

    const raw = options.understandingProvider
      ? { available: true as const, raw: await options.understandingProvider(understandRequest), provider: "fixture" }
      : await getAiGateway().understandQuery(understandRequest);

    if (!raw.available) {
      understandingSource = "fallback";
      understanding = await fallbackUnderstanding(userId, message, scope, now);
    } else {
      try {
        understanding = parseQueryUnderstanding(raw.raw, { currentDate: now, timezone: "UTC" });
      } catch {
        understandingSource = "fallback";
        understanding = await fallbackUnderstanding(userId, message, scope, now);
      }
    }
  } catch {
    understandingSource = "fallback";
    understanding = await fallbackUnderstanding(userId, message, scope, now);
  }

  // A scope-focused question keeps its scope even when the model
  // reports global — the caller's focus is authoritative.
  understanding = { ...understanding, scope };

  // Validate entity_id proposals against the KNOWN list: unknown or
  // foreign ids are stripped, never trusted. (The entity retriever
  // re-verifies ownership independently — defense in depth.)
  const knownIds = new Set(knownEntities.map((entity) => entity.id));
  understanding = {
    ...understanding,
    mentions: understanding.mentions.map((mention) => ({
      ...mention,
      entityId: mention.entityId && knownIds.has(mention.entityId) ? mention.entityId : null,
    })),
  };

  // 3. Save the user's question (verbatim) before retrieval.
  const savedConversationId = (await saveChatMessage(userId, { role: "user", content: message, conversationId: conversationId ?? undefined }))
    .conversationId;
  conversationId = savedConversationId;

  // 4. Plan → retrieve → merge → rank (bounded re-planning inside).
  const outcome = await runRetrieval(userId, message, understanding, {
    ...options,
    scopeId: request.scopeId ?? null,
    semantic: semanticAvailable() ? "available" : "deferred",
  });

  // 5. Graph edges that touch the context's nodes (bounded, labeled later).
  const nodes: Array<{ type: RelationNodeType; id: string }> = [
    ...outcome.candidates.map(({ memory }) => ({ type: "memory" as const, id: memory.id })),
    ...(outcome.entities ?? []).map((entity) => ({ type: "entity" as const, id: entity.entityId })),
  ];
  const relations = nodes.length > 0 ? await listRelationsTouchingNodes(userId, nodes, 40) : [];

  // 6. Build the context pack.
  const context = buildContext({
    query: message,
    understanding,
    candidates: outcome.candidates.map(({ candidate, relevance, memory }) => ({ candidate: { ...candidate, relevance }, memory })),
    entities: (outcome.entities ?? []).map((entity) => ({
      entityId: entity.entityId,
      name: entity.name,
      type: entity.type,
      basis: entity.basis,
    })),
    relations: relations.map((relation) => ({
      relationId: relation.id,
      relationType: relation.relationType,
      sourceType: relation.sourceType,
      sourceId: relation.sourceId,
      targetType: relation.targetType,
      targetId: relation.targetId,
      sourceLabel: null,
      targetLabel: null,
    })),
    ambiguity: outcome.ambiguity,
    run: {
      understandingSource,
      planIterations: outcome.plan.iteration,
      failures: outcome.failures,
      semantic: outcome.semantic,
      mergedCandidates: outcome.mergedCount,
    },
  });

  // 7. Route on the user's EXPLICIT intent (deterministic detection —
  //    a model never decides to mutate memory), then reason.
  const fullRows = new Map(outcome.candidates.map(({ memory }) => [memory.id, memory]));
  const reasoningPack = toReasoningPack(context, fullRows);

  let answer: ReasoningAnswer;
  let action: AskResult["action"];

  if (detectMemoryCapture(message)) {
    // Spec §17: capture routes to the Memory Orchestrator through the
    // memory module's public API — the existing pipeline stays the
    // authority. The chat layer never writes the database directly;
    // processing is scheduled by the route after the response.
    const memory = await createMemory(userId, { originalContent: message });
    answer = captureAnswer(message, memory.title);
    action = { kind: "captured", memoryId: memory.id, title: memory.title };
  } else if (detectDeletionRequest(message)) {
    ({ answer, action } = await handleDeletionRequest(userId, message, scope, request.scopeId ?? null, context));
  } else if (detectCountQuestion(message)) {
    // Spec §24: counts come from the database, not a model.
    answer = await countFromDatabase(userId, understanding.time.from, understanding.time.to);
  } else if (context.memories.length === 0) {
    // Spec §8: nothing retrieved — the honest line, no model.
    answer = noEvidenceAnswer(message);
  } else if (
    understanding.intent === "find" &&
    understanding.mentions.length === 0 &&
    !understanding.needsReasoning
  ) {
    // Spec §24: a plain structured listing needs no synthesis model.
    answer = listAnswer(
      message,
      context.memories.map((memory) => memory.memoryId)
    );
  } else {
    // ——— The grounded answer (spec §1–9): generate → verify →
    //      bounded regeneration → conservative ———
    try {
      answer = await reasonOverContext(
        {
          question: message,
          contextPack: reasoningPack,
          conversation: conversationTurns,
          currentDate: now,
          timezone: "UTC",
        },
        { answerProvider: options.answerProvider, verificationProvider: options.verificationProvider }
      );
    } catch {
      // A reasoning-layer bug never fabricates: the memories remain
      // the answer surface (spec §28).
      answer = reasoningFailedAnswer(message, context.memories.length);
    }
  }

  // 8. Persist the assistant record: the final answer and its
  //    provenance — never prompts, never hidden reasoning.
  await saveChatMessage(userId, {
    role: "assistant",
    content: answer.answer,
    conversationId,
    context: {
      intent: understanding.intent,
      memoryIds: answer.supportingMemoryIds,
      entityIds: context.entities.map((entity) => entity.entityId),
      understandingSource,
      planIterations: context.run.planIterations,
      answerStyle: answer.answerStyle,
      verificationStatus: answer.verification.status,
      ...(action ? { action } : {}),
    },
  });

  return {
    conversationId,
    understanding: {
      intent: understanding.intent,
      depth: understanding.depth,
      mentions: understanding.mentions,
      topics: understanding.topics,
      time: understanding.time,
      needsReasoning: understanding.needsReasoning,
      source: understandingSource,
    },
    context,
    answer,
    ...(action ? { action } : {}),
  };
}

/* ————————————————— Deletion (spec §18) ————————————————— */

/**
 * The server performs the deletion through the EXISTING memory
 * deletion flow (deleteMemory — ownership enforced, graph-safe
 * cleanup) only when the target is unambiguous: the focused memory of
 * a memory-scoped conversation, or exactly one retrieved candidate.
 * Anything else gets a concise clarification — never a guess.
 */
async function handleDeletionRequest(
  userId: string,
  message: string,
  scope: QueryScope,
  scopeId: string | null,
  context: ReturnType<typeof buildContext>
): Promise<{ answer: ReasoningAnswer; action: AskResult["action"] }> {
  // Focused memory: the conversation's own scope.
  if (scope === "memory" && scopeId) {
    const target = await findMemory(userId, scopeId).catch(() => null);
    if (target) {
      await deleteMemory(userId, target.id);
      return { answer: deletedAnswer(message, target.title), action: { kind: "deleted", memoryId: target.id, title: target.title } };
    }
  }

  // Unscoped: exactly one retrieved candidate may be deleted.
  if (context.memories.length === 1 && context.memories[0].provenance.relevance >= MIN_DELETE_RELEVANCE) {
    const target = await findMemory(userId, context.memories[0].memoryId).catch(() => null);
    if (target) {
      await deleteMemory(userId, target.id);
      return { answer: deletedAnswer(message, target.title), action: { kind: "deleted", memoryId: target.id, title: target.title } };
    }
  }

  const candidateMemoryIds = context.memories.map((memory) => memory.memoryId);
  const answer = candidateMemoryIds.length > 0
    ? clarificationAnswer(
        message,
        "مفيش ذكرى واحدة واضحة إمسي. دي اللي لقيتها — افتح اللي قصدك وامسحه من صفحته، أو وضّحلي أكتر.",
        "I can't tell which single memory you mean. These are the candidates — open the one you mean and delete it from its page, or tell me more about it.",
      )
    : clarificationAnswer(
        message,
        "معلشت، معرفش أوصف الذكرى اللي تقصد عليها إمسي. اتنين قولي عليها أكتر — أو امسحها من صفحتها.",
        "I couldn't find the memory you're asking to delete. Tell me more about it — or delete it from its own page.",
      );
  return { answer, action: { kind: "delete_clarification", candidateMemoryIds } };
}

/* ————————————————— Deterministic count (spec §24) ————————————————— */

async function countFromDatabase(userId: string, from: string | null, to: string | null): Promise<ReasoningAnswer> {
  // A resolved window counts inside the window; otherwise it's the
  // archive's active total. Real numbers, no model.
  if (from && to) {
    const window = { from: new Date(from), to: new Date(to) };
    const rows = await listMemoriesInWindow(userId, window, { limit: 1_000 }).catch(() => []);
    return countAnswer(`${from}..${to}`, rows.length, true);
  }
  const result = await listMemories(userId, { status: "active", pageSize: 1 }).catch(() => null);
  return countAnswer("count", result?.total ?? 0, false);
}

/* ————————————————— Reasoning pack projection ————————————————— */

/**
 * The ContextPack as the reasoning model sees it: plain, bounded
 * data. Memory excerpts are cut from the user's verbatim content
 * (richer than the UI snippet, capped for cost) — ids stay identical
 * to the pack the UI displays, so provenance links are exact.
 */
function toReasoningPack(
  context: ReturnType<typeof buildContext>,
  fullRows: Map<string, import("@/types/memory").Memory>
): ReasoningContextPack {
  return {
    query: context.query,
    scope: { kind: context.scope, id: null },
    understanding: {
      intent: context.understanding.intent,
      depth: context.understanding.depth,
      topics: context.understanding.topics,
      time: {
        kind: context.understanding.time.kind,
        from: context.understanding.time.from,
        to: context.understanding.time.to,
        uncertain: context.understanding.time.uncertain,
      },
      needsReasoning: context.understanding.needsReasoning,
    },
    memories: context.memories.map((memory) => {
      const full = fullRows.get(memory.memoryId);
      return {
        memoryId: memory.memoryId,
        title: memory.title,
        snippet: full ? full.originalContent.slice(0, REASONING_EXCERPT_LENGTH) : memory.snippet,
        memoryType: memory.memoryType,
        rememberedAt: memory.rememberedAt,
        createdAt: memory.createdAt,
      };
    }),
    entities: context.entities.map((entity) => ({ entityId: entity.entityId, name: entity.name, type: entity.type })),
    relations: context.relations.map((relation) => ({
      relationType: relation.relationType,
      sourceType: relation.sourceType,
      sourceId: relation.sourceId,
      targetType: relation.targetType,
      targetId: relation.targetId,
    })),
    timeline: context.timeline,
    uncertainties: context.uncertainties,
  };
}

async function fallbackUnderstanding(
  userId: string,
  message: string,
  scope: QueryScope,
  now: Date
): Promise<QueryUnderstanding> {
  return buildFallbackUnderstanding(message, userId, {
    currentDate: now,
    timezone: "UTC",
    scope,
  });
}
