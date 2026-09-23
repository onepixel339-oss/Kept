/**
 * /api/sources/[id]/retry — idempotent re-extraction (Phase 9 §37).
 *
 * Rate limited under the existing `process` rule (Phase 7 protection,
 * spec §32) — retries trigger extraction work and, when the source
 * was never linked, one memory creation. The service guarantees no
 * duplicates; the rate limit keeps the work bounded.
 */

import { after } from "next/server";
import { apiHandler, ok } from "@/lib/api";
import { requireCurrentUserId } from "@/modules/user";
import { checkRateLimit } from "@/modules/user/infrastructure/rate-limit";
import { retrySource } from "@/modules/ingestion";
import { findMemory } from "@/modules/memory";
import { processMemory } from "@/modules/intelligence";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const POST = apiHandler(async (request: Request, context: RouteContext) => {
  const userId = await requireCurrentUserId();

  const rl = checkRateLimit("process", userId);
  if (!rl.allowed) {
    return ok({ sourceId: "", status: "busy" as const, memoryId: null, sources: [], notices: [] });
  }

  const { id } = await context.params;
  const result = await retrySource(userId, id);

  // A retry that produced a memory hands it to the same pipeline.
  if (result.memoryId) {
    after(async () => {
      try {
        const memory = await findMemory(userId, result.memoryId!);
        if (memory) {
          await processMemory(memory);
        }
      } catch (error) {
        console.error("[intelligence] background processing failed after retry:", error);
      }
    });
  }

  return ok(result);
});
