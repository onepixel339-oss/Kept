/**
 * /api/memories/[id]/versions — a memory's append-only history,
 * oldest first. Ownership enforced before anything is returned.
 */

import { apiHandler, ok } from "@/lib/api";
import { requireCurrentUserId } from "@/modules/user";
import { getMemoryVersions } from "@/modules/memory";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const GET = apiHandler(async (_request: Request, context: RouteContext) => {
  const userId = await requireCurrentUserId();
  const { id } = await context.params;
  const versions = await getMemoryVersions(userId, id);
  return ok({ versions });
});
