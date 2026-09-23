/**
 * /api/memories — the front door of the product.
 *
 * POST creates a real memory: validate → the authenticated user →
 * create source + memory + v1 → return what was saved. Then, after
 * the response is on its way, real processing begins: the
 * intelligence pipeline analyzes, compares, and enriches — and the
 * memory's processing state (pending → processing → ready | failed)
 * reports honestly what happened. A failure NEVER loses the memory.
 *
 * GET lists the current user's memories with optional search and
 * filters. No session, no data — 401.
 *
 * Phase 7: identity is the authenticated session. The anonymous
 * auto-provisioning of earlier phases is gone — an archive belongs
 * to a real account. Creation is rate limited because every keep
 * triggers background AI processing.
 */

import { after } from "next/server";
import { apiHandler, ok, AppError } from "@/lib/api";
import { requireCurrentUserId } from "@/modules/user";
import { checkRateLimit } from "@/modules/user/infrastructure/rate-limit";
import { createMemory, listMemories } from "@/modules/memory";
import { processMemory } from "@/modules/intelligence";

export const POST = apiHandler(async (request: Request) => {
  const userId = await requireCurrentUserId();

  const rl = checkRateLimit("memoryCreate", userId);
  if (!rl.allowed) {
    throw new AppError(
      "rate_limited",
      "That's a lot of memories at once — take a breath and try again shortly."
    );
  }

  const body = await request.json().catch(() => undefined);
  const memory = await createMemory(userId, body);

  // The response is honest immediately: saved, processing pending.
  // Intelligence runs after the response lands — and whatever happens
  // there, this memory is already permanently kept.
  after(async () => {
    try {
      await processMemory(memory);
    } catch (error) {
      // processMemory never throws, but the boundary stays absolute:
      // a background failure must never crash the server.
      console.error("[intelligence] background processing failed:", error);
    }
  });

  return ok({ memory }, 201);
});

export const GET = apiHandler(async (request: Request) => {
  const userId = await requireCurrentUserId();
  const params = Object.fromEntries(new URL(request.url).searchParams);
  const result = await listMemories(userId, params);
  return ok(result);
});
