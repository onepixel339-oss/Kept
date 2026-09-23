/**
 * /api/auth/password — change the signed-in account's password.
 *
 * Requires the current password. Every existing session is
 * invalidated; a fresh session is issued for the current device
 * (cookie rotation happens here). The response never includes hashes
 * or tokens beyond the cookie itself.
 */

import { apiHandler, ok } from "@/lib/api";
import { requireUser, sessionCookie } from "@/modules/user";
import { changePassword } from "@/modules/user/application/account";

export const POST = apiHandler(async (request: Request) => {
  const user = await requireUser();
  const body = await request.json().catch(() => undefined);
  const session = await changePassword(user.id, body);

  const response = ok({ changed: true });
  const cookie = sessionCookie(session.token);
  response.cookies.set(cookie.name, cookie.value, cookie.options);
  return response;
});
