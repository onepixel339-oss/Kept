/**
 * Shared API contract types.
 *
 * Every API route answers with a predictable envelope so clients never
 * guess at shapes and errors are always first-class citizens. AI-proposed
 * data must pass through application validation BEFORE it is allowed
 * inside an ApiResult.
 */

/** Machine-readable error codes, stable across phases. */
export type ApiErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "validation_failed"
  | "conflict"
  | "rate_limited"
  | "internal_error";

export interface ApiError {
  code: ApiErrorCode;
  /** Human-readable, safe to display. Never includes internal details. */
  message: string;
}

/** The only shape an API route returns. */
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };
