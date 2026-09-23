/**
 * API plumbing — one error type, one response envelope, one place that
 * maps failures to HTTP. Route handlers stay thin; errors stay
 * predictable; database internals never leak to clients.
 *
 * Phase 7 additions:
 *  - Same-origin verification for state-changing requests when the
 *    client sends an Origin header (defense in depth beside
 *    SameSite=Lax cookies; header-less API clients are unaffected).
 *  - Error logging is trimmed to name + short message — full error
 *    objects can embed query parameters (password hashes, memory
 *    content), and private data must not reach the logs.
 */

import { NextResponse } from "next/server";
import { ZodError } from "zod";
import type { ApiError, ApiErrorCode, ApiResult } from "@/types/api";

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  validation_failed: 400,
  conflict: 409,
  rate_limited: 429,
  internal_error: 500,
};

/** The only error type services are allowed to throw. */
export class AppError extends Error {
  readonly code: ApiErrorCode;

  constructor(code: ApiErrorCode, message: string) {
    super(message);
    this.name = "AppError";
    this.code = code;
  }

  get status(): number {
    return STATUS_BY_CODE[this.code];
  }
}

export function ok<T>(data: T, status = 200): NextResponse<ApiResult<T>> {
  return NextResponse.json({ ok: true as const, data }, { status });
}

export function fail(error: ApiError, status: number): NextResponse<ApiResult<never>> {
  return NextResponse.json({ ok: false as const, error }, { status });
}

/**
 * Reject cross-site state changes when the browser declares an origin
 * that is not ours. SameSite=Lax already keeps the session cookie out
 * of cross-site posts; this is the second lock on the same door.
 * Requests without an Origin (curl, tests, same-origin agents that
 * omit it) pass through.
 */
function assertSameOriginIfDeclared(request: Request): void {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;

  const origin = request.headers.get("origin");
  if (!origin) return;

  const host = request.headers.get("host");
  if (!host) return;

  try {
    const originHost = new URL(origin).host;
    if (originHost !== host) {
      throw new AppError("forbidden", "This request didn't come from Kept.");
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("forbidden", "This request didn't come from Kept.");
  }
}

/** Operator-facing log line: what failed, never request payloads. */
function logUnexpectedError(error: unknown): void {
  const detail =
    error instanceof Error
      ? `${error.name}: ${error.message.slice(0, 300)}`
      : "unknown error";
  console.error("[api] unhandled error:", detail);
}

/**
 * Wrap a route handler: converts AppError and ZodError into the
 * envelope; anything unexpected becomes an honest 500 without details.
 * Handlers may answer with NextResponse (the envelope) or a plain
 * Response (file downloads such as /api/export).
 */
export function apiHandler<Args extends unknown[]>(
  handler: (...args: Args) => Promise<Response>
): (...args: Args) => Promise<Response> {
  return async (...args: Args) => {
    try {
      const request = args[0];
      if (request instanceof Request) {
        assertSameOriginIfDeclared(request);
      }
      return await handler(...args);
    } catch (error) {
      if (error instanceof AppError) {
        return fail({ code: error.code, message: error.message }, error.status);
      }
      if (error instanceof ZodError) {
        const issue = error.issues[0];
        return fail(
          {
            code: "validation_failed",
            message: issue
              ? `${issue.path.join(".") || "input"}: ${issue.message}`
              : "The request could not be validated.",
          },
          400
        );
      }
      // Logged for the operator in trimmed form; never surfaced to the client.
      logUnexpectedError(error);
      return fail(
        { code: "internal_error", message: "Something went wrong on our side." },
        500
      );
    }
  };
}
