/**
 * Conversation application service — bounded, honest persistence for
 * the Ask experience.
 *
 * Responsibilities:
 *  - Save the user's question verbatim (role "user").
 *  - Save the assistant's HONEST context record (role "assistant"):
 *    what was retrieved and why — never an invented answer.
 *  - Read a bounded recent window of one conversation for follow-up
 *    understanding. The whole history is never loaded.
 *
 * Ownership: every function takes an explicit userId and scopes by it.
 * Conversations are scoped per user; one user never sees or continues
 * another user's conversation (an unknown conversationId simply starts
 * a new one).
 */

import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import type { ChatMessage, ChatRole, ConversationWindow } from "@/types/conversation";
import { queryConfig } from "@/config/query";

const MAX_MESSAGE_LENGTH = 4_000;
const MAX_CONTEXT_JSON_LENGTH = 16_000;

function toChatMessage(row: {
  id: string;
  userId: string;
  conversationId: string;
  role: string;
  content: string;
  contextJson: string | null;
  createdAt: Date;
}): ChatMessage {
  let context: Record<string, unknown> | null = null;
  if (row.contextJson) {
    try {
      const parsed: unknown = JSON.parse(row.contextJson);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        context = parsed as Record<string, unknown>;
      }
    } catch {
      context = null; // a corrupt payload never breaks a read
    }
  }
  return {
    id: row.id,
    userId: row.userId,
    conversationId: row.conversationId,
    role: row.role as ChatRole,
    content: row.content,
    context,
    createdAt: row.createdAt,
  };
}

export interface SaveChatMessageInput {
  role: ChatRole;
  content: string;
  /** Server-assigned when absent (new conversation). */
  conversationId?: string;
  /** Structured provenance for assistant records. */
  context?: Record<string, unknown>;
}

/** Save one message. Returns the persisted message. */
export async function saveChatMessage(
  userId: string,
  input: SaveChatMessageInput
): Promise<ChatMessage> {
  const content = input.content.slice(0, MAX_MESSAGE_LENGTH).trim();
  const conversationId = input.conversationId?.trim() || randomUUID();
  const contextJson = input.context
    ? JSON.stringify(input.context).slice(0, MAX_CONTEXT_JSON_LENGTH)
    : null;

  const row = await db.chatMessage.create({
    data: {
      userId,
      conversationId,
      role: input.role,
      content: content === "" ? "(empty)" : content,
      contextJson,
    },
  });

  return toChatMessage(row);
}

/**
 * The bounded recent window of one conversation (oldest first), used
 * for follow-up understanding. Ownership-scoped: another user's
 * conversationId yields an empty window — never their words.
 */
export async function listRecentMessages(
  userId: string,
  conversationId: string,
  limit: number = queryConfig.budgets.conversationWindow
): Promise<ConversationWindow> {
  const safeLimit = Math.max(1, Math.min(20, Math.floor(limit)));
  const rows = await db.chatMessage.findMany({
    where: { userId, conversationId },
    orderBy: { createdAt: "desc" },
    take: safeLimit,
  });

  return {
    conversationId,
    messages: rows
      .reverse()
      .map((row) => ({ role: row.role as ChatRole, content: row.content, createdAt: row.createdAt })),
  };
}
