/**
 * /api/memories/[id]/process — retry (or finish) intelligence
 * processing for one memory.
 *
 * Safe by construction:
 *  - ownership is resolved first (cross-user ids look missing),
 *  - an already-running memory answers 409 instead of double-running,
 *  - the pipeline itself is idempotent: retries never duplicate
 *    memories, versions, relations, or links,
 *  - the response reports the real state — never a fake "ready".
 */

import { apiHandler, ok, AppError } from "@/lib/api";
import { requireCurrentUserId } from "@/modules/user";
import { checkRateLimit } from "@/modules/user/infrastructure/rate-limit";
import { getMemory } from "@/modules/memory";
import { processMemory } from "@/modules/intelligence";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const POST = apiHandler(async (_request: Request, context: RouteContext) => {
  const userId = await requireCurrentUserId();
  const { id } = await context.params;

  // Each processing run costs real AI work — bound the retries.
  const rl = checkRateLimit("process", userId);
  if (!rl.allowed) {
    throw new AppError(
      "rate_limited",
      "Too many retries in a row — try again in a few minutes."
    );
  }

  const memory = await getMemory(userId, id); // ownership enforced

  if (memory.processingStatus === "processing") {
    throw new AppError("conflict", "This memory is already being processed.");
  }

  // Synchronous retry: the user asked for it, the answer is the truth.
  const result = await processMemory(memory);

  const updated = await getMemory(userId, id);
  return ok({ memory: updated, processing: result });
});
