/**
 * /api/auth/reset/request — ask for a password reset.
 *
 * Honest behavior: the response is ALWAYS the same neutral message,
 * whether or not the account exists — enumeration gets nothing here.
 * When a real account exists, a short-lived single-use token is
 * created and handed to the delivery port.
 *
 * Email delivery is an explicitly DEFERRED integration: no mail
 * provider is configured in this environment, so the port's current
 * implementation delivers nowhere and nothing is pretended (no fake
 * "email sent" state is stored or shown — see docs/security.md).
 * The token lifecycle (creation, expiry, single use, session
 * invalidation on use) is real and covered by tests.
 */

import { apiHandler, ok } from "@/lib/api";
import { requestPasswordReset } from "@/modules/user/application/account";
import { clientKeyFromHeaders } from "@/modules/user/infrastructure/rate-limit";

const NEUTRAL_MESSAGE =
  "If an account exists for this email, a reset can be requested. " +
  "Email delivery isn't configured for this space yet, so reset " +
  "requests are recorded but not delivered — see Settings once " +
  "signed in.";

export const POST = apiHandler(async (request: Request) => {
  const body = await request.json().catch(() => undefined);
  await requestPasswordReset(body, clientKeyFromHeaders(request.headers));
  return ok({ message: NEUTRAL_MESSAGE });
});
