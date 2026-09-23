/**
 * /api/auth/reset/confirm — complete a password reset with a token.
 *
 * The token is single-use and short-lived; using it invalidates every
 * session of the account. Tokens never appear in responses or logs.
 */

import { apiHandler, ok } from "@/lib/api";
import { resetPassword } from "@/modules/user/application/account";

export const POST = apiHandler(async (request: Request) => {
  const body = await request.json().catch(() => undefined);
  await resetPassword(body);
  return ok({ reset: true });
});
