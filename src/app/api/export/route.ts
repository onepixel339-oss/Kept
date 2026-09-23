/**
 * /api/export — the authenticated user's complete data, as JSON.
 *
 * Contains ONLY the authenticated user's records. Never contains
 * password hashes, sessions, reset tokens, internal prompts, hidden
 * reasoning, or server diagnostics. Rate limited (cheap, not free).
 *
 * Answers with a raw Response (a downloadable file), not the usual
 * ApiResult envelope — the shape is the export format itself.
 */

import { apiHandler, AppError } from "@/lib/api";
import { requireUser } from "@/modules/user";
import { exportUserData } from "@/modules/user/application/data-rights";
import { checkRateLimit } from "@/modules/user/infrastructure/rate-limit";

export const GET = apiHandler(async () => {
  const user = await requireUser();

  const rl = checkRateLimit("export", user.id);
  if (!rl.allowed) {
    throw new AppError(
      "rate_limited",
      "Export is available again in a while — it was just downloaded."
    );
  }

  const payload = await exportUserData(user.id);

  const date = new Date().toISOString().slice(0, 10);
  return new Response(JSON.stringify(payload, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="kept-export-${date}.json"`,
      "Cache-Control": "no-store",
    },
  });
});
