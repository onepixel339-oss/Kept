/**
 * Gate error intelligence — pure helpers that turn a REAL Google API
 * error into precise, evidence-grade classification. Used by
 * scripts/live-gate.ts (and unit-tested in tests/unit/gate-errors.test.ts).
 *
 * Why this exists (V2): the previous gate guessed causes from substring
 * matching only. Google actually SENDS the diagnosis — the SDK surfaces
 * the full JSON error body (`{ error: { code, message, status, details } }`)
 * as the ApiError message — so quota metric, window, scope, tier and the
 * server-suggested retry delay are all there. Reading them is the
 * difference between "429 → quota, somewhere" and evidence like:
 *   "Free Tier, per-model, requests-per-day exhausted (limit: 0) —
 *    waiting cannot fix it inside this run; needs quota reset or billing."
 *
 * Everything here is pure: no I/O, no secrets, no network. Error bodies
 * never contain key material; message strings are still truncated before
 * they reach any log line.
 */

// ——————————————————————————————————————————————— shapes

interface GoogleErrorBody {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    details?: Array<Record<string, unknown>>;
  };
}

export interface AttemptRecord {
  /** 1-based attempt index. */
  n: number;
  httpStatus: number | null;
  googleStatus: string | null;
  /** Short server-side reason (truncated) — never key material. */
  note: string;
}

export interface ParsedGoogleError {
  source:
    | "api-error-json" // thrown ApiError whose message is the JSON body
    | "string-json" // reason string that IS the JSON body (provider.embed swallows errors)
    | "plain-message" // plain text (network errors, app-level messages)
    | "unknown";
  httpStatus: number | null;
  googleStatus: string | null;
  /** Server message, truncated for evidence hygiene. */
  message: string;
  /** google.rpc.RetryInfo.retryDelay, or the "Please retry in Xs" fallback. */
  retryDelayMs: number | null;
  /** google.rpc.QuotaFailure violation metrics, e.g.
   *  "generativelanguage.googleapis.com/generate_content_free_tier_requests". */
  quotaMetrics: string[];
  quotaSubjects: string[];
  /** google.rpc.ErrorInfo reason, e.g.
   *  "GENERATE_CONTENT_REQUESTS_PER_MINUTE_PER_PROJECT_PER_MODEL". */
  errorReason: string | null;
  errorMetadata: Record<string, string>;
  /** "limit: 0" signature — plan/daily exhaustion, not a short window. */
  limitZero: boolean;
}

export type QuotaWindow = "RPM" | "TPM" | "RPD" | "unspecified";
export type QuotaScope = "per-model" | "per-project" | "unknown";
export type QuotaTier = "free-tier" | "unspecified";

export interface QuotaProfile {
  window: QuotaWindow;
  scope: QuotaScope;
  tier: QuotaTier;
  metric: string | null;
  reason: string | null;
  /** Per-minute/token-bucket window — safe to wait & retry inside the gate. */
  shortWindow: boolean;
  /** Daily or plan-level exhaustion — an external blocker until reset/tier change. */
  dailyOrPlanExhausted: boolean;
  /** One-line human evidence (metric + window + scope + tier + Google's own hint). */
  note: string;
}

// ——————————————————————————————————————————————— primitives

/** Truncate evidence text — brevity is also a security property. */
export function truncateForEvidence(text: string, max = 200): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

/**
 * Parse a Google retryDelay string: "37s" | "22.187681ms" | "1.5s" | "2m".
 * Returns milliseconds, or null when unparsable.
 */
export function parseRetryDelayMs(value: string): number | null {
  const match = /^\s*([\d.]+)\s*(ms|s|m)\s*$/i.exec(value);
  if (!match) return null;
  const amount = Number.parseFloat(match[1]);
  if (!Number.isFinite(amount)) return null;
  const unit = match[2].toLowerCase();
  if (unit === "ms") return Math.round(amount);
  if (unit === "s") return Math.round(amount * 1000);
  return Math.round(amount * 60_000);
}

function delayFromBody(body: GoogleErrorBody): number | null {
  const details = body.error?.details ?? [];
  for (const detail of details) {
    const type = typeof detail["@type"] === "string" ? (detail["@type"] as string) : "";
    if (!type.endsWith("RetryInfo")) continue;
    const raw = typeof detail.retryDelay === "string" ? detail.retryDelay : null;
    if (raw) {
      const parsed = parseRetryDelayMs(raw);
      if (parsed !== null) return parsed;
    }
  }
  return null;
}

function delayFromMessage(message: string): number | null {
  // e.g. "Please retry in 22.187681ms" / "Please retry in 33.5s"
  const match = /retry in\s+([\d.]+)\s*(ms|s|m)\b/i.exec(message);
  if (!match) return null;
  return parseRetryDelayMs(`${match[1]}${match[2]}`);
}

/**
 * Parse ANY error shape the gate can encounter:
 *  - a thrown ApiError (message === JSON.stringify({error:{...}})),
 *  - a reason STRING that is itself the JSON body (the provider's
 *    embed() swallows thrown errors into { available:false, reason }),
 *  - plain messages (network failures, app-level errors).
 * No guessing: unknown inputs simply yield nulls.
 */
export function parseGoogleError(error: unknown): ParsedGoogleError {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : String(error);

  const fromBody = (body: GoogleErrorBody, source: ParsedGoogleError["source"]): ParsedGoogleError => {
    const inner = body.error ?? {};
    const message = typeof inner.message === "string" ? inner.message : "";
    const details = Array.isArray(inner.details) ? inner.details : [];
    const quotaMetrics: string[] = [];
    const quotaSubjects: string[] = [];
    let errorReason: string | null = null;
    let errorMetadata: Record<string, string> = {};
    let retryDelayMs = delayFromBody(body);

    for (const detail of details) {
      const type = typeof detail["@type"] === "string" ? (detail["@type"] as string) : "";
      if (type.endsWith("QuotaFailure") && Array.isArray(detail.violations)) {
        for (const violation of detail.violations as Array<Record<string, unknown>>) {
          if (typeof violation.quotaMetric === "string") quotaMetrics.push(violation.quotaMetric);
          if (typeof violation.subject === "string") quotaSubjects.push(violation.subject);
        }
      }
      if (type.endsWith("ErrorInfo") && typeof detail.reason === "string") {
        errorReason = detail.reason;
        const meta = detail.metadata;
        if (meta && typeof meta === "object") {
          errorMetadata = Object.fromEntries(
            Object.entries(meta as Record<string, unknown>).map(([k, v]) => [k, String(v)])
          );
        }
      }
    }

    if (retryDelayMs === null && message) retryDelayMs = delayFromMessage(message);

    return {
      source,
      httpStatus: typeof inner.code === "number" ? inner.code : null,
      googleStatus: typeof inner.status === "string" ? inner.status : null,
      message: truncateForEvidence(message || raw),
      retryDelayMs,
      quotaMetrics,
      quotaSubjects,
      errorReason,
      errorMetadata,
      limitZero: /limit:\s*0\b/.test(message),
    };
  };

  // 1. Direct JSON body (thrown ApiError, or an error/reason string that IS JSON).
  if (raw.trim().startsWith("{")) {
    try {
      const body = JSON.parse(raw) as GoogleErrorBody;
      if (body && typeof body === "object" && body.error) {
        return fromBody(body, error instanceof Error ? "api-error-json" : "string-json");
      }
    } catch {
      // fall through to plain-message
    }
  }

  // 2. Plain message — keep it short, extract nothing.
  return {
    source: error === undefined || error === null ? "unknown" : "plain-message",
    httpStatus: null,
    googleStatus: null,
    message: truncateForEvidence(raw),
    retryDelayMs: null,
    quotaMetrics: [],
    quotaSubjects: [],
    errorReason: null,
    errorMetadata: {},
    limitZero: /limit:\s*0\b/.test(raw),
  };
}

// ——————————————————————————————————————————————— classification

/** 503 / UNAVAILABLE — Google-side capacity ("high demand", "overloaded").
 *  Transient provider availability: NEVER an auth, model, SDK or app fault. */
export function isTransientUnavailable(parsed: ParsedGoogleError): boolean {
  if (parsed.httpStatus === 503) return true;
  return parsed.googleStatus === "UNAVAILABLE";
}

/** 429 / RESOURCE_EXHAUSTED — quota. The KIND of quota comes from the body. */
export function isQuotaExhausted(parsed: ParsedGoogleError): boolean {
  if (parsed.httpStatus === 429) return true;
  return parsed.googleStatus === "RESOURCE_EXHAUSTED";
}

/**
 * Turn a parsed 429 into a precise quota profile — from the BODY, not
 * from the status code alone. Detection order for the window: the
 * ErrorInfo reason carries the most specific signal
 * ("...PER_MODEL_PER_DAY", "...PER_MINUTE_PER_PROJECT..."), then the
 * quota metric name, then the human message.
 */
export function describeQuota(parsed: ParsedGoogleError): QuotaProfile {
  const signals = [parsed.errorReason, ...parsed.quotaMetrics, parsed.message]
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .map((s) => s.toLowerCase());

  const has = (...needles: string[]): boolean =>
    signals.some((signal) => needles.some((needle) => signal.includes(needle)));

  // — window (RPD wins: it changes the remedy, so check it first)
  let window: QuotaWindow = "unspecified";
  if (has("per_day", "perday", "per day", "_daily")) window = "RPD";
  else if (has("token")) window = "TPM";
  else if (has("per_minute", "perminute", "per minute")) window = "RPM";

  // — scope (per-model wins over per-project: both can appear in one reason)
  let scope: QuotaScope = "unknown";
  if (has("per_model", "permodel")) scope = "per-model";
  else if (has("per_project", "perproject")) scope = "per-project";

  // — tier
  const tier: QuotaTier = has("free_tier", "freetier", "free tier") ? "free-tier" : "unspecified";

  const metric = parsed.quotaMetrics[0] ?? null;
  const shortWindow = window === "RPM" || window === "TPM";
  const dailyOrPlanExhausted = window === "RPD" || parsed.limitZero;

  const parts: string[] = [];
  if (metric) parts.push(`metric=${metric}`);
  if (parsed.errorReason) parts.push(`reason=${parsed.errorReason}`);
  if (window !== "unspecified") parts.push(`window=${window}`);
  if (scope !== "unknown") parts.push(`scope=${scope}`);
  if (tier !== "unspecified") parts.push(`tier=${tier}`);
  if (parsed.limitZero) parts.push("limit: 0 (no allocation for this key/tier)");
  if (parsed.retryDelayMs !== null) parts.push(`google says retry in ${(parsed.retryDelayMs / 1000).toFixed(1)}s`);

  return {
    window,
    scope,
    tier,
    metric,
    reason: parsed.errorReason,
    shortWindow,
    dailyOrPlanExhausted,
    note: parts.length > 0 ? truncateForEvidence(parts.join("; "), 260) : "quota exhausted (Google body carried no quota details)",
  };
}

// ——————————————————————————————————————————————— backoff math

/**
 * Exponential backoff for retry #retryIndex (1-based): base, base×2,
 * base×4 … capped. Deterministic — the gate adds no random jitter, so
 * runs stay reproducible and evidence stays comparable.
 */
export function backoffDelayMs(retryIndex: number, baseMs: number, capMs: number): number {
  const shifted = Math.max(1, Math.floor(retryIndex));
  const raw = baseMs * Math.pow(2, shifted - 1);
  return Math.min(capMs, Math.round(raw));
}

// ——————————————————————————————————————————————— evidence

/** Compact attempt log for evidence lines: "attempts=3 [#1 503 UNAVAILABLE …; #2 …]" */
export function formatAttempts(attempts: AttemptRecord[]): string {
  if (attempts.length === 0) return "attempts=0";
  const rendered = attempts
    .map((a) => {
      const status = [a.httpStatus ?? "?", a.googleStatus ?? ""].filter(Boolean).join(" ");
      return `#${a.n} ${status}${a.note ? ` — ${truncateForEvidence(a.note, 120)}` : ""}`;
    })
    .join("; ");
  return `attempts=${attempts.length} [${truncateForEvidence(rendered, 400)}]`;
}
