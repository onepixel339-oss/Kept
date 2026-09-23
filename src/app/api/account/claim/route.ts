/**
 * /api/account/claim — EXPLICITLY import the browser's old anonymous
 * (pre-account) local data into the signed-in account.
 *
 * This is the one and only door between development data and a real
 * account, and the user is the one who opens it. The legacy signed
 * cookie acts as the claim ticket; only anonymous rows (no email, no
 * password) qualify. The migration is transactional, colliding
 * entities are merged rather than duplicated, and the legacy cookie
 * is cleared in the same response — one shot, done.
 */

import { cookies } from "next/headers";
import { apiHandler, ok } from "@/lib/api";
import { IDENTITY_COOKIE } from "@/lib/identity";
import { requireUser } from "@/modules/user";
import {
  claimLocalIdentity,
  previewLegacyClaim,
} from "@/modules/user/application/data-rights";

export const GET = apiHandler(async () => {
  const user = await requireUser();
  const store = await cookies();
  const preview = await previewLegacyClaim(
    user.id,
    store.get(IDENTITY_COOKIE)?.value
  );
  return ok({ preview });
});

export const POST = apiHandler(async () => {
  const user = await requireUser();
  const store = await cookies();
  const legacyValue = store.get(IDENTITY_COOKIE)?.value;

  const summary = await claimLocalIdentity(user.id, legacyValue);

  const response = ok({ claimed: summary });
  // The ticket is spent: clear the legacy cookie so this can only
  // ever happen once.
  response.cookies.set(IDENTITY_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
  return response;
});
