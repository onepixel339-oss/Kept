/**
 * /api/chat — the Ask pipeline's front door (Phase 5: grounded
 * reasoning + memory chat, spec §19 + Phase 5).
 *
 * The flow inside askMemorySpace:
 *   authenticate → save the user message → understand (AI proposal
 *   validated, deterministic fallback) → plan → retrieve → build
 *   context → route on the explicit chat intent (capture / deletion /
 *   count / empty / listing / reasoning) → persist the honest
 *   assistant record.
 *
 * When the user explicitly captured a memory during chat, real
 * processing begins after the response lands — exactly like
 * POST /api/memories: the Memory Orchestrator analyzes, compares, and
 * enriches through its normal pipeline. A failure NEVER loses the
 * memory. No identity, no data — 401.
 */

import { after } from "next/server";
import { apiHandler, ok, AppError } from "@/lib/api";
import { requireCurrentUserId } from "@/modules/user";
import { checkRateLimit } from "@/modules/user/infrastructure/rate-limit";
import { askMemorySpace } from "@/modules/query";
import { processMemory } from "@/modules/intelligence";
import { getMemory } from "@/modules/memory";
import { z } from "zod";
import { QUERY_SCOPES } from "@/types/query";

const askRequestSchema = z.object({
  message: z.string().min(1).max(4_000),
  conversationId: z.string().max(200).nullish(),
  scope: z.enum(QUERY_SCOPES).optional(),
  scopeId: z.string().max(200).nullish(),
});

export const POST = apiHandler(async (request: Request) => {
  const userId = await requireCurrentUserId();

  // The Ask pipeline runs retrieval and AI calls — refreshing or
  // replaying must not multiply them without bound.
  const rl = checkRateLimit("chat", userId);
  if (!rl.allowed) {
    throw new AppError(
      "rate_limited",
      "You're asking quickly — give the space a moment, then ask again."
    );
  }

  const body = await request.json().catch(() => undefined);
  const parsed = askRequestSchema.parse(body);

  const result = await askMemorySpace(userId, {
    message: parsed.message,
    conversationId: parsed.conversationId ?? null,
    scope: parsed.scope,
    scopeId: parsed.scopeId ?? null,
  });

  // An explicit in-chat capture becomes a real memory through the
  // Memory Orchestrator — after the response is on its way.
  if (result.action?.kind === "captured") {
    const memoryId = result.action.memoryId;
    const full = await getMemory(userId, memoryId);
    after(async () => {
      try {
        await processMemory(full);
      } catch (error) {
        // processMemory never throws, but the boundary stays absolute:
        // a background failure must never crash the server.
        console.error("[intelligence] background processing failed:", error);
      }
    });
  }

  return ok(result);
});
