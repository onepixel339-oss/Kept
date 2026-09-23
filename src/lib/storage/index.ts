/**
 * Storage abstraction (Phase 9 §29) — the seam between Kept and
 * wherever user originals live.
 *
 * The application never hardcodes filesystem paths and never learns
 * where bytes actually reside: it handles opaque keys returned by this
 * module. The local adapter keeps development simple (§30); a future
 * object-storage adapter implements the same five operations and the
 * application does not change.
 *
 * Safety rules (binding):
 *  - Keys are generated HERE, server-side, from safe characters —
 *    user-controlled filenames never become storage paths.
 *  - Every operation re-validates the key (no traversal, no absolute
 *    paths, no escaping the root).
 *  - Stored originals are private: access happens only through
 *    authenticated, ownership-checked routes. There is no public URL.
 */

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { STORAGE_ROOT_ENV } from "@/config/ingestion";
import { SupabaseStorageProvider, serviceConfig } from "./supabase";

export interface StorageProvider {
  /** Store bytes under a key. */
  put(key: string, data: Buffer): Promise<void>;
  /** Read bytes back, or null when absent. */
  get(key: string): Promise<Buffer | null>;
  /** Remove one object; deleting an absent key is not an error. */
  delete(key: string): Promise<void>;
  /** Whether the key currently holds bytes. */
  exists(key: string): Promise<boolean>;
  /** Size of the object, or null when absent. */
  size(key: string): Promise<number | null>;
}

/** A stable, path-safe key for one user object. */
export function buildStorageKey(userId: string, extension: string): string {
  const safeExt = extension.replace(/[^a-z0-9]/gi, "").slice(0, 8);
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const unique = randomBytes(12).toString("hex");
  const ext = safeExt ? `.${safeExt}` : "";
  return `u/${userId}/${yyyy}/${mm}/${unique}${ext}`;
}

function resolveUnderRoot(root: string, key: string): string {
  if (!key || key.includes("..") || key.includes("\0") || path.isAbsolute(key)) {
    throw new Error("Invalid storage key.");
  }
  const resolved = path.resolve(root, key);
  const normalizedRoot = path.resolve(root);
  if (!resolved.startsWith(normalizedRoot + path.sep)) {
    throw new Error("Invalid storage key.");
  }
  return resolved;
}

/** Local filesystem adapter — the Phase 9 development implementation. */
export class LocalStorageProvider implements StorageProvider {
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  async put(key: string, data: Buffer): Promise<void> {
    const target = resolveUnderRoot(this.root, key);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data, { flag: "wx" });
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      const target = resolveUnderRoot(this.root, key);
      return await readFile(target);
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      const target = resolveUnderRoot(this.root, key);
      await rm(target, { force: true });
    } catch {
      // Absent or already removed — deletion stays idempotent.
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      const target = resolveUnderRoot(this.root, key);
      await stat(target);
      return true;
    } catch {
      return false;
    }
  }

  async size(key: string): Promise<number | null> {
    try {
      const target = resolveUnderRoot(this.root, key);
      const info = await stat(target);
      return info.size;
    } catch {
      return null;
    }
  }
}

function defaultRoot(): string {
  const fromEnv = process.env[STORAGE_ROOT_ENV]?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  // Development default: inside the project, outside public/ — nothing
  // here is ever served statically.
  return path.resolve(process.cwd(), "storage", "uploads");
}

let cached: StorageProvider | null = null;

/**
 * The application's one storage instance.
 *
 * Driver selection (explicit, env-driven):
 *  - SUPABASE_URL + SUPABASE_SECRET_KEY both set → Supabase Storage
 *    (production / any environment with real cloud persistence).
 *  - otherwise → LocalStorageProvider (development; INGESTION_STORAGE_ROOT
 *    may re-point the root, tests swap the instance entirely).
 * The swap is the Phase 9 §29 seam working as designed: zero application
 * changes, the same five operations.
 */
export function getStorage(): StorageProvider {
  if (!cached) {
    if (serviceConfig()) {
      cached = new SupabaseStorageProvider();
    } else {
      cached = new LocalStorageProvider(defaultRoot());
    }
  }
  return cached;
}

/** Test/operations helper: swap the storage implementation. */
export function setStorage(provider: StorageProvider | null): void {
  cached = provider;
}
