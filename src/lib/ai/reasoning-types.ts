/**
 * AI reasoning contracts — the Phase 5 seam.
 *
 * ARCHITECTURAL LAW (docs/architecture.md §2.1), unchanged:
 *   The AI never touches the database. It never decides anything.
 *   It receives the question and the structured ContextPack (plain
 *   data, already retrieved and ranked by the query module) and
 *   PROPOSES a grounded answer. The reasoning module validates the
 *   proposal (zod), grounds every claim against the pack, and the
 *   verification loop decides what the user finally sees.
 *
 * Two operations, both raw-text proposals:
 *  - generateAnswer — compose a natural answer FROM the pack only.
 *  - verifyAnswer   — audit a generated answer against the same pack.
 *
 * The reasoning model never retrieves. If the pack is missing
 * something, the honest answer is "the memories don't say" — never a
 * second search behind the planner's back.
 */

import type { QueryConversationTurn } from "./query-types";

/**
 * The context pack as the reasoning model sees it: bounded, plain
 * data. Shaped like (a projection of) the query module's ContextPack
 * — memory ids are the join key for claim provenance.
 */
export interface ReasoningContextMemory {
  memoryId: string;
  title: string | null;
  snippet: string;
  memoryType: string;
  rememberedAt: string | null;
  createdAt: string;
}

export interface ReasoningContextEntity {
  entityId: string;
  name: string;
  type: string;
}

export interface ReasoningContextRelation {
  relationType: string;
  sourceType: string;
  sourceId: string;
  targetType: string;
  targetId: string;
}

export interface ReasoningContextPack {
  query: string;
  scope: { kind: "global" | "memory" | "entity" | "topic"; id: string | null };
  understanding: {
    intent: string;
    depth: string;
    topics: string[];
    time: { kind: string; from: string | null; to: string | null; uncertain: boolean };
    needsReasoning: boolean;
  };
  memories: ReasoningContextMemory[];
  entities: ReasoningContextEntity[];
  relations: ReasoningContextRelation[];
  timeline: Array<{ memoryId: string; title: string | null; when: string | null; dateIsProxy: boolean }>;
  /** Honest caveats the system already knows (approximate time, fallbacks). */
  uncertainties: string[];
}

/** Verification feedback handed back to the generator on regeneration. */
export interface VerificationFeedback {
  valid: boolean;
  unsupported_claims: string[];
  temporal_errors: string[];
  entity_errors: string[];
  source_mismatches: string[];
  required_changes: string[];
}

export interface GenerateAnswerRequest {
  /** The user's question, verbatim. */
  question: string;
  /** The structured pack retrieved for THIS question — the only evidence. */
  contextPack: ReasoningContextPack;
  /** Bounded recent conversation (oldest first) for follow-up framing. */
  conversation: QueryConversationTurn[];
  /** Current date (ISO 8601) — for tense and relative phrasing only. */
  currentDate: string;
  /** IANA timezone the system operates in. */
  timezone: string;
  /**
   * Previous attempt's verification report when regenerating. The
   * generator must fix the listed problems — not redefend them.
   */
  feedback?: VerificationFeedback | null;
}

export interface VerifyAnswerRequest {
  /** The user's question, verbatim. */
  question: string;
  /** The generated answer under audit. */
  answer: {
    text: string;
    claims: Array<{ text: string; type: string; memory_ids: string[] }>;
    uncertainties: string[];
    answer_style: string;
  };
  /** The same pack the generator saw — the only allowed evidence. */
  contextPack: ReasoningContextPack;
  currentDate: string;
  timezone: string;
}
