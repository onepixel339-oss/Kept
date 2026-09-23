/**
 * Rate limiting — abuse protection for sensitive endpoints.
 *
 * Implementation: an in-process sliding window. This is deliberately
 * simple and deliberately REPLACEABLE: every limit is declared in one
 * table, applied through one helper, and the store sits behind two
 * functions (check + reset). Moving to a shared store (Redis, or a
 * SQLite table for multi-process deployments) is a swap of these
 * functions, not a redesign — see docs/security.md.
 *
 * Honest limitation, documented: the window is per server process.
 * The current deployment model is a single Node process (Next
 * standalone server), so per-process equals per-server here. If the
 * deployment ever becomes multi-process, the store must move to a
 * shared implementation — that is a documented debt, not a hidden one.
 *
 * Keys are coarse (route + ip, route + userId). No request bodies,
 * memory content, or credentials ever enter this module.
 */

export interface RateLimitRule {
  /** Requests allowed per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

/** Declared limits — one place, reviewed, documented. */
export const RATE_LIMITS = {
  /** Credential guessing. 10 tries / 5 minutes per client. */
  login: { limit: 10, windowMs: 5 * 60 * 1000 },
  /** Account creation floods. 10 / hour per client. */
  signup: { limit: 10, windowMs: 60 * 60 * 1000 },
  /** Reset-request flooding (and email enumeration pressure). 5 / hour. */
  resetRequest: { limit: 5, windowMs: 60 * 60 * 1000 },
  /** The Ask pipeline triggers retrieval + AI calls. 30 / 5 min per user. */
  chat: { limit: 30, windowMs: 5 * 60 * 1000 },
  /** Memory (re)processing triggers the AI pipeline. 20 / 5 min per user. */
  process: { limit: 20, windowMs: 5 * 60 * 1000 },
  /** Memory creation (each triggers background AI). 40 / 5 min per user. */
  memoryCreate: { limit: 40, windowMs: 5 * 60 * 1000 },
  /**
   * Rich ingestion (Phase 9 §32) — uploads, OCR/vision, transcription,
   * and URL fetches are expensive. 30 / 5 min per user, alongside the
   * memoryCreate budget (the pipeline behind it is the same).
   */
  ingest: { limit: 30, windowMs: 5 * 60 * 1000 },
  /** Data export — cheap but not free. 10 / hour per user. */
  export: { limit: 10, windowMs: 60 * 60 * 1000 },
} as const satisfies Record<string, RateLimitRule>;

export type RateLimitName = keyof typeof RATE_LIMITS;

interface Bucket {
  timestamps: number[];
}

const buckets = new Map<string, Bucket>();

/** Coarse client key: leftmost forwarded IP, else the socket-less "local". */
export function clientKeyFromHeaders(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return headers.get("x-real-ip")?.trim() || "local";
}

export interface RateLimitOutcome {
  allowed: boolean;
  /** Seconds until the oldest request leaves the window. */
  retryAfterSeconds: number;
  remaining: number;
}

/** Check (and, when allowed, record) one request against a rule. */
export function checkRateLimit(
  name: RateLimitName,
  key: string,
  now: number = Date.now()
): RateLimitOutcome {
  const rule = RATE_LIMITS[name];
  const bucketKey = `${name}:${key}`;
  const bucket = buckets.get(bucketKey) ?? { timestamps: [] };

  // Drop timestamps that have left the window.
  bucket.timestamps = bucket.timestamps.filter((t) => now - t < rule.windowMs);

  if (bucket.timestamps.length >= rule.limit) {
    const oldest = bucket.timestamps[0];
    buckets.set(bucketKey, bucket);
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((oldest + rule.windowMs - now) / 1000)),
      remaining: 0,
    };
  }

  bucket.timestamps.push(now);
  buckets.set(bucketKey, bucket);
  return {
    allowed: true,
    retryAfterSeconds: 0,
    remaining: rule.limit - bucket.timestamps.length,
  };
}

/** Test/operations helper: clear one rule's buckets (or all of them). */
export function resetRateLimits(name?: RateLimitName): void {
  if (!name) {
    buckets.clear();
    return;
  }
  for (const bucketKey of buckets.keys()) {
    if (bucketKey.startsWith(`${name}:`)) {
      buckets.delete(bucketKey);
    }
  }
}
