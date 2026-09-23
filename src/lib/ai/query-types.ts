/**
 * AI query-understanding contracts — the Phase 4 seam.
 *
 * ARCHITECTURAL LAW (docs/architecture.md §2.1), unchanged:
 *   The AI never touches the database. It never decides anything.
 *   It receives the user's question (plus bounded conversation
 *   context) and PROPOSES a structured understanding. The query
 *   module validates the proposal (zod) and the planner decides how
 *   retrieval proceeds.
 *
 * The proposal arrives as raw JSON text — untrusted until the query
 * module parses it against its schema. A failed or unavailable
 * understanding NEVER blocks the question: the query module falls
 * back to a conservative deterministic understanding built from the
 * user's own words and entities. Retrieval must never depend on
 * free-form model text.
 */

/** The bounded conversation slice understanding may see. */
export interface QueryConversationTurn {
  role: "user" | "assistant";
  content: string;
}

export interface UnderstandQueryRequest {
  /** The user's question, verbatim. */
  message: string;
  /** Current date (ISO 8601) — for resolving relative time. */
  currentDate: string;
  /** IANA timezone the system operates in. */
  timezone: string;
  /** Where the question looks (global, or focused on one node). */
  scope: { kind: "global" | "memory" | "entity" | "topic"; id: string | null };
  /** Bounded recent conversation (oldest first) for follow-up resolution. */
  conversation: QueryConversationTurn[];
  /**
   * The user's own saved entities (bounded, plain data — never DB
   * models). Understanding MAY propose that a mention refers to one
   * of these by id; the proposal is a hint, validated by the query
   * module. Deterministic resolution always outranks it, ambiguity is
   * never resolved by it, and unknown ids are stripped.
   */
  knownEntities: Array<{ id: string; type: string; name: string }>;
}
