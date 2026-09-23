/**
 * /api/auth/login — sign in with email and password.
 *
 * Errors are uniform: unknown email and wrong password are the same
 * 401 with the same message, at the same computational cost. Every
 * successful login issues a fresh session (rotation). Rate limited
 * per client to blunt credential guessing.
 */

import { apiHandler, ok } from "@/lib/api";
import { signIn, sessionCookie } from "@/modules/user";
import { clientKeyFromHeaders } from "@/modules/user/infrastructure/rate-limit";

export const POST = apiHandler(async (request: Request) => {
  const body = await request.json().catch(() => undefined);
  const { user, session } = await signIn(body, clientKeyFromHeaders(request.headers));

  const response = ok(
    { user: { id: user.id, email: user.email, name: user.name } },
    200
  );
  const cookie = sessionCookie(session.token);
  response.cookies.set(cookie.name, cookie.value, cookie.options);
  return response;
});
