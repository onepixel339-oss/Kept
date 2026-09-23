/**
 * /api/search — grouped search over the user's own memory.
 *
 * Runs the deterministic pipeline end to end: NO AI call is required
 * for search (spec §18). The question is understood with the
 * fallback's deterministic machinery — words, the user's own entity
 * names, resolvable time windows — then planned, retrieved, merged,
 * and ranked by the same engine Ask uses. No identity, no data — 401.
 */

import { apiHandler, ok } from "@/lib/api";
import { requireCurrentUserId } from "@/modules/user";
import { searchMemorySpace } from "@/modules/query";

export const GET = apiHandler(async (request: Request) => {
  const userId = await requireCurrentUserId();

  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  if (q === "") {
    return ok({
      query: "",
      memories: [],
      entities: [],
      topics: [],
      semantic: "not_planned" as const,
      planIterations: 0,
      failures: [],
      time: { from: null, to: null, uncertain: false, expression: null },
    });
  }

  const result = await searchMemorySpace(userId, q);
  return ok(result);
});
