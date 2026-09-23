/**
 * Reasoning configuration — Phase 5's bounded, tunable dials.
 *
 * Same discipline as config/query.ts: every number exists because a
 * behavior needed a guardrail, each carries its rationale, and none
 * of them are hardcoded truths. The reasoning layer's budget protects
 * the user from runaway generation loops and the product's
 * free-to-use promise from needless AI calls.
 */

export const reasoningConfig = {
  /**
   * Answer regeneration attempts after a failed verification
   * (spec §7). One bounded retry with the verification feedback;
   * after that the pipeline composes a conservative answer from the
   * claims that survived — it never loops indefinitely.
   */
  maxRegenerationAttempts: 1,

  /**
   * Maximum claims one answer may carry. An answer that needs more
   * than this many claims is a summary dump, not an answer; the
   * schema rejects beyond it so a runaway proposal cannot bloat
   * persistence or provenance rendering.
   */
  maxClaims: 12,

  /** Maximum characters of one claim text. */
  maxClaimLength: 600,

  /** Maximum characters of the answer text (prose, bullets included). */
  maxAnswerLength: 6_000,

  /**
   * Memory ids citable by one claim. Claims that "cite" more memories
   * than exist in the pack are grounded against nothing.
   */
  maxMemoryIdsPerClaim: 8,

  /**
   * Answer sizes the API returns, by style — the UI renders them as
   * prose; the cap keeps a pathological proposal from flooding the
   * conversation record.
   */
  // (length caps above serve this; no separate field needed)

  /**
   * When the AI provider cannot generate answers (or fails), the ask
   * pipeline answers deterministically. This switch exists so the
   * honest-fallback behavior is documented in configuration, not
   * buried in a code path.
   */
  deterministicFallback: true,
} as const;

export type ReasoningConfig = typeof reasoningConfig;
