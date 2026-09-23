/**
 * Reasoning module — the final layer between retrieval and the user.
 *
 * Turns the ContextPack (Phase 4's boundary) into a grounded
 * natural-language answer, under the product's prime directive:
 *
 *     AI proposes → application validates → grounding decides →
 *     the user reads only what survives.
 *
 * Owns:
 *  - the answer/verification proposal schemas (zod — where reasoning
 *    output becomes trusted)
 *  - deterministic grounding (fabricated provenance discarded,
 *    unsupported facts demoted — the law, independent of any model)
 *  - the bounded verification loop (generate → verify → regenerate
 *    at most once → conservative composition)
 *  - honest no-evidence / partial-evidence / provider-failure
 *    behavior (spec §8, §28) — no hallucination, in the user's language
 *
 * Depends on:
 *  - `lib/ai` (generateAnswer/verifyAnswer via the gateway — the only
 *    door to providers)
 *  - shared query types (the ContextPack vocabulary)
 *
 * Boundary rules:
 *  - The reasoning model never retrieves. It sees the pack it was
 *    handed — nothing else. If the pack is missing something, the
 *    answer says so; it never searches again behind the planner's back.
 *  - No hidden reasoning leaves this module: callers get the final
 *    answer, claims, provenance, and a verification status — never
 *    raw provider output or prompts.
 *  - Persistence happens ABOVE this module (the ask pipeline saves
 *    the answer as an assistant message); this module never writes.
 */

export {
  reasonOverContext,
  type ReasoningRequest,
  type ReasoningAnswer,
  type ReasoningOptions,
} from "./application/reasoning-service";

export {
  answerProposalSchema,
  verificationProposalSchema,
  parseAnswerProposal,
  parseVerificationProposal,
  ANSWER_STYLES,
  type AnswerProposal,
  type AnswerStyle,
  type VerificationProposal,
} from "./domain/answer-schemas";

export {
  groundAnswerProposal,
  deterministicChecks,
  isVerificationValid,
  type GroundedClaim,
  type GroundingOutcome,
} from "./domain/grounding";

export {
  noEvidenceAnswer,
  partialEvidenceAnswer,
  reasoningFailedAnswer,
  countAnswer,
  listAnswer,
  captureAnswer,
  deletedAnswer,
  clarificationAnswer,
  isArabicQuestion,
} from "./domain/honest-lines";
