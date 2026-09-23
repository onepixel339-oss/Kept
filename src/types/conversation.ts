/**
 * Shared conversation types — the Ask experience's persistence layer.
 *
 * Phase 4 keeps this deliberately small: the ask pipeline saves the
 * user's question and an honest assistant context record (what was
 * retrieved — never an invented answer). Full reasoning belongs to
 * Phase 5.
 */

/** Who produced a message. "assistant" records are system-authored. */
export const CHAT_ROLES = ["user", "assistant"] as const;

export type ChatRole = (typeof CHAT_ROLES)[number];

export interface ChatMessage {
  id: string;
  userId: string;
  /** Groups an exchange and its follow-ups. Server-assigned when absent. */
  conversationId: string;
  role: ChatRole;
  /** The user's words verbatim, or the assistant's honest context note. */
  content: string;
  /** Structured provenance payload (assistant records): what was
   *  retrieved and why. JSON-serialized by the repository. */
  context: Record<string, unknown> | null;
  createdAt: Date;
}

/** A bounded slice of recent conversation, oldest first. */
export interface ConversationWindow {
  conversationId: string;
  messages: Array<{ role: ChatRole; content: string; createdAt: Date }>;
}
