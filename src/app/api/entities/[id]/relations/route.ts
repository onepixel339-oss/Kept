/**
 * /api/entities/[id]/relations — the relation graph around one entity,
 * endpoints resolved into human labels. Scoped to the current user.
 */

import { apiHandler, ok } from "@/lib/api";
import { requireCurrentUserId } from "@/modules/user";
import { getEntityRelations } from "@/modules/entity";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const GET = apiHandler(async (_request: Request, context: RouteContext) => {
  const userId = await requireCurrentUserId();
  const { id } = await context.params;
  const relations = await getEntityRelations(userId, id);
  return ok({ relations });
});
