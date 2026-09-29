/**
 * Gate error intelligence unit tests — the V2 classifier's behavior on
 * SYNTHETIC Google error bodies. These tests prove the classification
 * rules only (pure functions); they never touch the network and are not
 * part of the live gate. Live behavior is proven by scripts/live-gate.ts
 * against the real API.
 */
import { describe, expect, it } from "vitest";

import {
  backoffDelayMs,
  describeQuota,
  formatAttempts,
  isQuotaExhausted,
  isTransientUnavailable,
  parseGoogleError,
  parseRetryDelayMs,
  truncateForEvidence,
} from "../../scripts/lib/gate-errors";

/** The exact shape the SDK surfaces: ApiError(message = JSON.stringify(body)). */
function apiError(body: unknown): Error {
  const error = new Error(JSON.stringify(body));
  error.name = "ApiError";
  return error;
}

// ———————————————————— real-shaped Google bodies ——————————————————

const BODY_503_HIGH_DEMAND = {
  error: {
    code: 503,
    message: "The model is overloaded. Please try again later.",
    status: "UNAVAILABLE",
  },
};

const BODY_503_WITH_RETRY_DELAY = {
  error: {
    code: 503,
    message: "This model is currently experiencing high demand",
    status: "UNAVAILABLE",
    details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "20s" }],
  },
};

const BODY_429_RPD_FREE_TIER = {
  error: {
    code: 429,
    message:
      "You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To buy more or increase limits, see https://ai.google.dev/gemini-api/docs/pricing",
    status: "RESOURCE_EXHAUSTED",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.QuotaFailure",
        violations: [
          {
            quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests",
            subject: "quota_target: modelfree_tier",
          },
        ],
      },
      { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "GENERATE_CONTENT_FREE_TIER_REQUESTS_PER_MODEL_PER_DAY", domain: "googleapis.com", metadata: { service: "generativelanguage.googleapis.com" } },
      { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "22s" },
    ],
  },
};

const BODY_429_RPM_PER_PROJECT_PER_MODEL = {
  error: {
    code: 429,
    message: "You exceeded your current quota, please check your plan and billing details.",
    status: "RESOURCE_EXHAUSTED",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.QuotaFailure",
        violations: [{ quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests" }],
      },
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        reason: "GENERATE_CONTENT_REQUESTS_PER_MINUTE_PER_PROJECT_PER_MODEL",
        domain: "googleapis.com",
      },
      { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "37s" },
    ],
  },
};

const BODY_429_TPM_TOKEN_BUCKETS = {
  error: {
    code: 429,
    message: "You exceeded your current quota.",
    status: "RESOURCE_EXHAUSTED",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.QuotaFailure",
        violations: [
          {
            quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_input_token_buckets",
          },
        ],
      },
    ],
  },
};

const BODY_429_LIMIT_ZERO = {
  error: {
    code: 429,
    message:
      "You exceeded your current quota, please check your plan and billing details. limit: 0, requested: 1. Please retry in 22.187681ms",
    status: "RESOURCE_EXHAUSTED",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.QuotaFailure",
        violations: [{ quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests" }],
      },
    ],
  },
};

// ———————————————————— parsing —————————————————————————————————————

describe("parseGoogleError", () => {
  it("parses a thrown ApiError whose message is the JSON body", () => {
    const parsed = parseGoogleError(apiError(BODY_503_HIGH_DEMAND));
    expect(parsed.source).toBe("api-error-json");
    expect(parsed.httpStatus).toBe(503);
    expect(parsed.googleStatus).toBe("UNAVAILABLE");
    expect(parsed.message).toContain("overloaded");
  });

  it("parses a reason STRING that is itself the JSON body (provider.embed swallows errors)", () => {
    const reason = JSON.stringify(BODY_429_RPM_PER_PROJECT_PER_MODEL);
    const parsed = parseGoogleError(reason);
    expect(parsed.source).toBe("string-json");
    expect(parsed.httpStatus).toBe(429);
    expect(parsed.retryDelayMs).toBe(37_000);
  });

  it("extracts RetryInfo.retryDelay from details", () => {
    const parsed = parseGoogleError(apiError(BODY_503_WITH_RETRY_DELAY));
    expect(parsed.retryDelayMs).toBe(20_000);
  });

  it("falls back to 'Please retry in X' inside the message", () => {
    const parsed = parseGoogleError(apiError(BODY_429_LIMIT_ZERO));
    expect(parsed.retryDelayMs).toBe(22); // "22.187681ms" → 22ms
    expect(parsed.limitZero).toBe(true);
  });

  it("extracts QuotaFailure metrics and ErrorInfo reason/metadata", () => {
    const parsed = parseGoogleError(apiError(BODY_429_RPD_FREE_TIER));
    expect(parsed.quotaMetrics).toEqual(["generativelanguage.googleapis.com/generate_content_free_tier_requests"]);
    expect(parsed.quotaSubjects).toEqual(["quota_target: modelfree_tier"]);
    expect(parsed.errorReason).toBe("GENERATE_CONTENT_FREE_TIER_REQUESTS_PER_MODEL_PER_DAY");
    expect(parsed.errorMetadata.service).toBe("generativelanguage.googleapis.com");
  });

  it("treats plain messages honestly (no guessed statuses)", () => {
    const parsed = parseGoogleError(new Error("The analysis service returned an empty response."));
    expect(parsed.source).toBe("plain-message");
    expect(parsed.httpStatus).toBeNull();
    expect(parsed.googleStatus).toBeNull();
    expect(parsed.retryDelayMs).toBeNull();
  });

  it("truncates long messages for evidence hygiene", () => {
    const long = "x".repeat(500);
    expect(parseGoogleError(new Error(long)).message.length).toBeLessThanOrEqual(200);
  });
});

describe("parseRetryDelayMs", () => {
  it("parses seconds, sub-second and raw milliseconds", () => {
    expect(parseRetryDelayMs("37s")).toBe(37_000);
    expect(parseRetryDelayMs("1.5s")).toBe(1_500);
    expect(parseRetryDelayMs("22.187681ms")).toBe(22);
    expect(parseRetryDelayMs("2m")).toBe(120_000);
    expect(parseRetryDelayMs("soon")).toBeNull();
  });
});

// ———————————————————— classification ——————————————————————————————

describe("isTransientUnavailable / isQuotaExhausted", () => {
  it("503 UNAVAILABLE is transient, not quota", () => {
    const parsed = parseGoogleError(apiError(BODY_503_HIGH_DEMAND));
    expect(isTransientUnavailable(parsed)).toBe(true);
    expect(isQuotaExhausted(parsed)).toBe(false);
  });

  it("429 RESOURCE_EXHAUSTED is quota, not transient", () => {
    const parsed = parseGoogleError(apiError(BODY_429_RPM_PER_PROJECT_PER_MODEL));
    expect(isQuotaExhausted(parsed)).toBe(true);
    expect(isTransientUnavailable(parsed)).toBe(false);
  });
});

describe("describeQuota — window / scope / tier from the REAL body", () => {
  it("free-tier per-model per-day exhaustion (RPD)", () => {
    const profile = describeQuota(parseGoogleError(apiError(BODY_429_RPD_FREE_TIER)));
    expect(profile.window).toBe("RPD");
    expect(profile.scope).toBe("per-model");
    expect(profile.tier).toBe("free-tier");
    expect(profile.dailyOrPlanExhausted).toBe(true);
    expect(profile.shortWindow).toBe(false);
    expect(profile.note).toContain("generate_content_free_tier_requests");
    expect(profile.note).toContain("PER_MODEL_PER_DAY");
  });

  it("per-minute per-project-per-model window (RPM) is retryable in-run", () => {
    const profile = describeQuota(parseGoogleError(apiError(BODY_429_RPM_PER_PROJECT_PER_MODEL)));
    expect(profile.window).toBe("RPM");
    expect(profile.scope).toBe("per-model"); // per-model wins when both appear
    expect(profile.shortWindow).toBe(true);
    expect(profile.dailyOrPlanExhausted).toBe(false);
  });

  it("token-bucket metric maps to TPM", () => {
    const profile = describeQuota(parseGoogleError(apiError(BODY_429_TPM_TOKEN_BUCKETS)));
    expect(profile.window).toBe("TPM");
    expect(profile.tier).toBe("free-tier");
    expect(profile.shortWindow).toBe(true);
  });

  it("limit: 0 means plan-level exhaustion even without an ErrorInfo reason", () => {
    const profile = describeQuota(parseGoogleError(apiError(BODY_429_LIMIT_ZERO)));
    expect(profile.dailyOrPlanExhausted).toBe(true);
    expect(profile.note).toContain("limit: 0");
  });

  it("per-project scope when no per-model signal exists", () => {
    const body = {
      error: {
        code: 429,
        message: "quota exceeded",
        status: "RESOURCE_EXHAUSTED",
        details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "GENERATE_CONTENT_REQUESTS_PER_MINUTE_PER_PROJECT" }],
      },
    };
    const profile = describeQuota(parseGoogleError(apiError(body)));
    expect(profile.window).toBe("RPM");
    expect(profile.scope).toBe("per-project");
  });

  it("a 429 with no quota details stays honest and unspecified", () => {
    const profile = describeQuota(parseGoogleError(apiError({ error: { code: 429, message: "quota", status: "RESOURCE_EXHAUSTED" } })));
    expect(profile.window).toBe("unspecified");
    expect(profile.scope).toBe("unknown");
    expect(profile.note).toContain("no quota details");
  });
});

// ———————————————————— backoff + evidence ——————————————————————————

describe("backoffDelayMs", () => {
  it("exponential with a hard cap, deterministic", () => {
    expect(backoffDelayMs(1, 2_000, 15_000)).toBe(2_000);
    expect(backoffDelayMs(2, 2_000, 15_000)).toBe(4_000);
    expect(backoffDelayMs(3, 2_000, 15_000)).toBe(8_000);
    expect(backoffDelayMs(5, 2_000, 15_000)).toBe(15_000);
  });
});

describe("formatAttempts", () => {
  it("reports the attempt COUNT and short statuses only", () => {
    const line = formatAttempts([
      { n: 1, httpStatus: 503, googleStatus: "UNAVAILABLE", note: "high demand" },
      { n: 2, httpStatus: 503, googleStatus: "UNAVAILABLE", note: "high demand" },
      { n: 3, httpStatus: 503, googleStatus: "UNAVAILABLE", note: "high demand" },
    ]);
    expect(line).toMatch(/^attempts=3 \[/);
    expect(line).toContain("#1 503 UNAVAILABLE");
    expect(line).toContain("#3 503 UNAVAILABLE");
  });

  it("truncates pathological attempt notes", () => {
    const line = formatAttempts([{ n: 1, httpStatus: null, googleStatus: null, note: "y".repeat(1000) }]);
    expect(line.length).toBeLessThan(500);
  });
});

describe("truncateForEvidence", () => {
  it("collapses whitespace and truncates with an ellipsis", () => {
    expect(truncateForEvidence("a\n  b\t c")).toBe("a b c");
    const out = truncateForEvidence("z".repeat(300), 50);
    expect(out.length).toBe(50);
    expect(out.endsWith("…")).toBe(true);
  });
});
