/**
 * /api/entities/[id] — read one entity. Scoped to the current user.
 */

import { apiHandler, ok } from "@/lib/api";
import { requireCurrentUserId } from "@/modules/user";
import { getEntity } from "@/modules/entity";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const GET = apiHandler(async (_request: Request, context: RouteContext) => {
  const userId = await requireCurrentUserId();
  const { id } = await context.params;
  const entity = await getEntity(userId, id);
  return ok({ entity });
});
