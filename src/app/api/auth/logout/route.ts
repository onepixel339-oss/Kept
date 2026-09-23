/**
 * /api/auth/logout — end the current session.
 *
 * The session row is deleted server-side; the cookie is cleared.
 * Not a client-side flag — after this, the token is dead even if it
 * was copied somewhere.
 */

import { cookies } from "next/headers";
import { apiHandler, ok } from "@/lib/api";
import {
  SESSION_COOKIE,
  clearedSessionCookie,
} from "@/modules/user/application/current-user";
import { signOut } from "@/modules/user/application/account";

export const POST = apiHandler(async () => {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value ?? null;
  await signOut(token);

  const response = ok({ signedOut: true });
  const cleared = clearedSessionCookie();
  response.cookies.set(cleared.name, cleared.value, cleared.options);
  return response;
});
