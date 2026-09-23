/**
 * /api/entities/[id]/memories — the memories linked to an entity via
 * memory_entities. Scoped to the current user.
 */

import { apiHandler, ok } from "@/lib/api";
import { requireCurrentUserId } from "@/modules/user";
import { getEntityMemories } from "@/modules/entity";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const GET = apiHandler(async (_request: Request, context: RouteContext) => {
  const userId = await requireCurrentUserId();
  const { id } = await context.params;
  const memories = await getEntityMemories(userId, id);
  return ok({ memories });
});
