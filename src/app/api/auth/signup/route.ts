/**
 * /api/auth/signup — create a real account and start a session.
 *
 * The response sets the session cookie (HttpOnly, SameSite=Lax,
 * Secure in production). Duplicate emails answer 409 with a
 * human, non-technical message that never echoes the password.
 * Rate limited per client (see rate-limit.ts).
 */

import { apiHandler, ok } from "@/lib/api";
import { signUp, sessionCookie } from "@/modules/user";
import { clientKeyFromHeaders } from "@/modules/user/infrastructure/rate-limit";

export const POST = apiHandler(async (request: Request) => {
  const body = await request.json().catch(() => undefined);
  const { user, session } = await signUp(body, clientKeyFromHeaders(request.headers));

  const response = ok(
    { user: { id: user.id, email: user.email, name: user.name } },
    201
  );
  const cookie = sessionCookie(session.token);
  response.cookies.set(cookie.name, cookie.value, cookie.options);
  return response;
});
