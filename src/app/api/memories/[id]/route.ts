/**
 * /api/memories/[id] — read, edit, and delete one memory.
 * Every path resolves the current user first; cross-user ids are
 * indistinguishable from missing ones (404), so ownership never leaks
 * existence.
 */

import { apiHandler, ok } from "@/lib/api";
import { requireCurrentUserId } from "@/modules/user";
import { deleteMemory, getMemory, updateMemory } from "@/modules/memory";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const GET = apiHandler(async (_request: Request, context: RouteContext) => {
  const userId = await requireCurrentUserId();
  const { id } = await context.params;
  const memory = await getMemory(userId, id);
  return ok({ memory });
});

export const PATCH = apiHandler(async (request: Request, context: RouteContext) => {
  const userId = await requireCurrentUserId();
  const { id } = await context.params;
  const body = await request.json().catch(() => undefined);
  const memory = await updateMemory(userId, id, body);
  return ok({ memory });
});

export const DELETE = apiHandler(async (_request: Request, context: RouteContext) => {
  const userId = await requireCurrentUserId();
  const { id } = await context.params;
  await deleteMemory(userId, id);
  return ok({ deleted: true });
});
