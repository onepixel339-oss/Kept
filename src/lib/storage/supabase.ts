/**
 * Supabase Storage adapter — the production StorageProvider.
 *
 * Implements the same five operations as the local adapter (Phase 9
 * §29) against Supabase Storage's REST API, using only fetch — the
 * project gains no new dependency and the application code does not
 * change (it only ever sees opaque keys).
 *
 * Selection: getStorage() picks this adapter automatically when
 * SUPABASE_URL + SUPABASE_SECRET_KEY are both set (see index.ts).
 *
 * Safety rules (unchanged, binding):
 *  - Keys are generated server-side by buildStorageKey() from safe
 *    characters; this adapter re-validates every key (no traversal,
 *    no absolute paths) before it becomes part of a URL.
 *  - The bucket is PRIVATE: objects are served only through the
 *    authenticated, ownership-checked /api/sources/[id]/file route.
 *    The service key never reaches the client.
 *  - Deletion is idempotent; a missing object is not an error.
 *
 * Env:
 *  - SUPABASE_URL          e.g. https://<project-ref>.supabase.co
 *  - SUPABASE_SECRET_KEY   sb_secret_... (service role — server only)
 *  - KEPT_SUPABASE_BUCKET  optional bucket name (default kept-uploads)
 */

import { STORAGE_BUCKET_ENV } from "@/config/ingestion";

const DEFAULT_BUCKET = "kept-uploads";

/** The same key rules as the local adapter's resolveUnderRoot. */
function validateKey(key: string): void {
  if (!key || key.includes("..") || key.includes("\0") || key.startsWith("/")) {
    throw new Error("Invalid storage key.");
  }
}

function bucketName(): string {
  return process.env[STORAGE_BUCKET_ENV]?.trim() || DEFAULT_BUCKET;
}

/** Both env vars present → the Supabase driver is selectable. */
export function serviceConfig(): { base: string; key: string } | null {
  const base = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SECRET_KEY?.trim();
  if (!base || !key) return null;
  return { base: base.replace(/\/+$/, ""), key };
}

let bucketReady = false;

/**
 * One-time private-bucket provisioning. Idempotent: when the bucket
 * already exists, Supabase reports "Duplicate" and we treat it as
 * success. A failure here is a real deployment problem — thrown, not
 * swallowed (the ingestion pipeline reports it honestly).
 */
async function authHeaders(extra: Record<string, string> = {}): Promise<Record<string, string>> {
  const cfg = serviceConfig();
  if (!cfg) throw new Error("Supabase storage is not configured.");
  if (!bucketReady) {
    const res = await fetch(`${cfg.base}/storage/v1/bucket`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: bucketName(), public: false }),
    });
    if (!res.ok) {
      const body = await res.text();
      if (!/duplicate|already exists/i.test(body)) {
        throw new Error(`Supabase bucket provisioning failed (${res.status}).`);
      }
    }
    bucketReady = true;
  }
  return { Authorization: `Bearer ${cfg.key}`, ...extra };
}

function objectUrl(key: string): string {
  validateKey(key);
  const cfg = serviceConfig();
  if (!cfg) throw new Error("Supabase storage is not configured.");
  const encoded = key.split("/").map(encodeURIComponent).join("/");
  return `${cfg.base}/storage/v1/object/${bucketName()}/${encoded}`;
}

export class SupabaseStorageProvider {
  async put(key: string, data: Buffer): Promise<void> {
    const res = await fetch(objectUrl(key), {
      method: "POST",
      headers: await authHeaders({
        "Content-Type": "application/octet-stream",
        "x-upsert": "true",
      }),
      body: new Uint8Array(data),
    });
    if (!res.ok) throw new Error(`Supabase storage put failed (${res.status}).`);
  }

  async get(key: string): Promise<Buffer | null> {
    const res = await fetch(objectUrl(key), {
      method: "GET",
      headers: await authHeaders(),
    });
    if (res.status === 400 || res.status === 404) return null;
    if (!res.ok) throw new Error(`Supabase storage get failed (${res.status}).`);
    return Buffer.from(await res.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    const res = await fetch(objectUrl(key), {
      method: "DELETE",
      headers: await authHeaders(),
    });
    // Absent or already removed — deletion stays idempotent.
    if (res.ok || res.status === 400 || res.status === 404) return;
    throw new Error(`Supabase storage delete failed (${res.status}).`);
  }

  async exists(key: string): Promise<boolean> {
    const res = await fetch(objectUrl(key), {
      method: "HEAD",
      headers: await authHeaders(),
    });
    return res.ok;
  }

  async size(key: string): Promise<number | null> {
    const res = await fetch(objectUrl(key), {
      method: "HEAD",
      headers: await authHeaders(),
    });
    if (!res.ok) return null;
    const len = res.headers.get("content-length");
    return len ? Number(len) : null;
  }
}
