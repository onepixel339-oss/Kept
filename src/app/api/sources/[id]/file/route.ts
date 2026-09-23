/**
 * /api/sources/[id]/file — controlled access to a preserved original
 * (Phase 9 §6, §29).
 *
 * The storage seam's key never appears in any URL and never becomes a
 * filesystem path here: the route authenticates, loads the source
 * through an owned path, and streams exactly the bytes the storage
 * provider returns. Cross-user requests look like missing sources —
 * one user's archive is invisible to another. Nothing is cacheable,
 * nothing is public, downloads are explicit.
 */

import { apiHandler, AppError } from "@/lib/api";
import { requireCurrentUserId } from "@/modules/user";
import { findSource, toSourceView } from "@/modules/ingestion";
import { getStorage } from "@/lib/storage";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const GET = apiHandler(async (request: Request, context: RouteContext) => {
  const userId = await requireCurrentUserId();
  const { id } = await context.params;

  const source = await findSource(userId, id);
  if (!source) {
    throw new AppError("not_found", "That source could not be found.");
  }

  const metadata = source.metadata ?? {};
  const url = new URL(request.url);
  const wantThumbnail = url.searchParams.get("variant") === "thumb";
  const wantDownload = url.searchParams.get("download") === "1";

  const key = wantThumbnail
    ? typeof metadata.thumbnailKey === "string" && metadata.thumbnailKey !== ""
      ? metadata.thumbnailKey
      : null
    : source.storageKey;

  if (!key) {
    throw new AppError("not_found", "This source has no stored original.");
  }

  const bytes = await getStorage().get(key);
  if (!bytes) {
    // The row exists, the object is gone — an honest, reportable state.
    throw new AppError("not_found", "The original could not be found.");
  }

  const view = toSourceView(source);
  const mime = wantThumbnail ? "image/webp" : (view.mimeType ?? "application/octet-stream");

  const filename = (view.label ?? "original").replace(/["\\\r\n]/g, "_");
  const disposition = wantDownload ? "attachment" : "inline";

  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "content-type": mime,
      "content-length": String(bytes.length),
      "content-disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
});
