/**
 * /api/account — delete the signed-in account, for real.
 *
 * The flow: authenticated session → password confirmation →
 * transactional deletion of every owned record (memories, versions,
 * entities, links, relations, sources, chats, sessions, tokens) →
 * the account row itself. The session cookie is cleared in the same
 * response. Deterministic, complete, and scoped strictly to the
 * authenticated user.
 */

import { cookies } from "next/headers";
import { apiHandler, ok } from "@/lib/api";
import {
  SESSION_COOKIE,
  requireUser,
  clearedSessionCookie,
} from "@/modules/user";
import { deleteAccount } from "@/modules/user/application/data-rights";

export const DELETE = apiHandler(async (request: Request) => {
  const user = await requireUser();
  const body = await request.json().catch(() => undefined);
  const summary = await deleteAccount(user.id, body);

  // Defensive: the account's sessions died by cascade; make sure the
  // current cookie cannot authenticate anything anywhere.
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value ?? null;
  if (token) {
    const { invalidateSessionByToken } = await import(
      "@/modules/user/application/current-user"
    );
    await invalidateSessionByToken(token);
  }

  const response = ok({ deleted: true, summary });
  const cleared = clearedSessionCookie();
  response.cookies.set(cleared.name, cleared.value, cleared.options);
  return response;
});
