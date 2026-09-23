/**
 * Conversation module — bounded persistence for the Ask experience.
 *
 * Owns:
 *  - chat_messages: the user's questions (verbatim) and the
 *    assistant's honest context records (what was retrieved — never
 *    an invented answer)
 *  - bounded conversation windows for follow-up understanding
 *
 * Phase 4 keeps this module deliberately small. A real chat surface —
 * full reasoning, answer streaming, verification — belongs to Phase 5
 * and will compose THIS module with the query module's pipeline.
 *
 * Depends on:
 *  - `@/lib/db` (its own table only)
 *  - `@/config/query` (the conversation window budget)
 *
 * Boundary rules: every function takes an explicit userId; one user
 * never reads another user's conversation.
 */

export {
  saveChatMessage,
  listRecentMessages,
  type SaveChatMessageInput,
} from "./application/conversation-service";
