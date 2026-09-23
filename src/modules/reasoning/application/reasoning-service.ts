/**
 * Reasoning service — the final layer: ContextPack → grounded answer.
 *
 * The loop (spec §7), bounded by construction:
 *
 *   generateAnswer (AI proposal, raw JSON)
 *     → validate schema (zod) → ground deterministically against the
 *       pack (fabricated ids discarded, unsupported facts demoted)
 *     → verifyAnswer (AI audit) + deterministic checks → merged report
 *
 *   valid        → return the answer (status: passed | regenerated)
 *   invalid      → regenerate ONCE with the verification feedback
 *   still invalid→ conservative answer: only claims that survived
 *                  grounding AND were not flagged, composed
 *                  deterministically; if none survive, the honest
 *                  partial-evidence line
 *
 * Never loops indefinitely (max 1 regeneration). Never invents: an
 * empty pack returns the honest no-evidence answer without any AI
 * call, and the reasoning model never retrieves — it sees only the
 * pack it was handed.
 *
 * Honesty rules encoded here (spec §8, §28):
 *  - No provider capability / provider failure → a deterministic,
 *    retrieval-honest response; the memories themselves remain the
 *    answer surface. Never a fabricated reply.
 *  - No hidden chain-of-thought leaves this module: the caller gets
 *    the final answer, claims, provenance, and a verification status —
 *    never raw provider output.
 */

import { getAiGateway } from "@/lib/ai";
import type {
  GenerateAnswerRequest,
  QueryConversationTurn,
  ReasoningContextPack,
  VerificationFeedback,
  VerifyAnswerRequest,
} from "@/lib/ai";
import { reasoningConfig } from "@/config/reasoning";
import {
  parseAnswerProposal,
  parseVerificationProposal,
  type AnswerProposal,
  type AnswerStyle,
} from "../domain/answer-schemas";
import {
  deterministicChecks,
  groundAnswerProposal,
  isVerificationValid,
  type GroundedClaim,
} from "../domain/grounding";

export interface ReasoningRequest {
  question: string;
  contextPack: ReasoningContextPack;
  conversation: QueryConversationTurn[];
  currentDate?: Date;
  timezone?: string;
}

export interface ReasoningAnswer {
  answer: string;
  claims: GroundedClaim[];
  supportingMemoryIds: string[];
  supportingMemoryCount: number;
  uncertainties: string[];
  answerStyle: AnswerStyle;
  /**
   * How the answer was reached:
   *  - "passed"        — first attempt verified clean
   *  - "regenerated"   — the bounded retry verified clean
   *  - "conservative"  — verification failed twice; only surviving
   *                      claims composed deterministically
   *  - "deterministic" — no AI involved (empty context, unavailable
   *                      provider, or provider failure)
   */
  verification: { status: "passed" | "regenerated" | "conservative" | "deterministic"; issues: string[] };
  source: "ai" | "deterministic";
}

export interface ReasoningOptions {
  /**
   * Test seam: a stand-in for the gateway's generateAnswer (raw JSON
   * text, exactly like a provider returns). Production never sets it;
   * tests never point the real gateway at the network.
   */
  answerProvider?: (request: GenerateAnswerRequest) => Promise<string>;
  /** Test seam: a stand-in for the gateway's verifyAnswer. */
  verificationProvider?: (request: VerifyAnswerRequest) => Promise<string>;
}

const MAX_ISSUES_FOR_FEEDBACK = 8;

export async function reasonOverContext(
  request: ReasoningRequest,
  options: ReasoningOptions = {}
): Promise<ReasoningAnswer> {
  const pack = request.contextPack;
  const now = request.currentDate ?? new Date();
  const timezone = request.timezone ?? "UTC";

  // ——— Empty context: the honest answer needs no model (spec §8) ———
  if (pack.memories.length === 0) {
    return {
      answer: noEvidenceLine(request.question),
      claims: [],
      supportingMemoryIds: [],
      supportingMemoryCount: 0,
      uncertainties: [],
      answerStyle: "no_evidence",
      verification: { status: "deterministic", issues: [] },
      source: "deterministic",
    };
  }

  const baseRequest: Omit<GenerateAnswerRequest, "feedback"> = {
    question: request.question,
    contextPack: pack,
    conversation: request.conversation,
    currentDate: now.toISOString(),
    timezone,
  };

  // ——— Attempt 1 ———
  const first = await attempt(baseRequest, null, options);
  if (first.answer) return first.answer;

  // ——— Attempt 2: one bounded regeneration with the feedback ———
  const second = await attempt(baseRequest, first.feedback, options);
  if (second.answer) {
    return { ...second.answer, verification: { ...second.answer.verification, status: "regenerated" } };
  }

  // ——— Conservative answer: only what survived, composed here ———
  return conservativeAnswer(first, second, request.question);
}

/* ————————————————— One generation + verification attempt ————————————————— */

interface AttemptOutcome {
  /** Set when the attempt produced a trustworthy answer. */
  answer: ReasoningAnswer | null;
  /** The merged verification report when the attempt failed. */
  feedback: VerificationFeedback | null;
  /** Claims that survived grounding on this attempt (for the
   *  conservative composition when verification failed). */
  survivors: GroundedClaim[];
}

async function attempt(
  base: Omit<GenerateAnswerRequest, "feedback">,
  feedback: VerificationFeedback | null,
  options: ReasoningOptions
): Promise<AttemptOutcome> {
  let proposal: AnswerProposal;

  // ——— Generate (AI proposal; any failure falls through to honest
  //      deterministic behavior — never fabricated text) ———
  try {
    const raw = options.answerProvider
      ? { available: true as const, raw: await options.answerProvider({ ...base, feedback }), provider: "fixture" }
      : await getAiGateway().generateAnswer({ ...base, feedback });

    if (!raw.available) {
      return { answer: providerUnavailableAnswer(base.contextPack), feedback: null, survivors: [] };
    }
    proposal = parseAnswerProposal(raw.raw);
  } catch {
    return { answer: providerUnavailableAnswer(base.contextPack), feedback: null, survivors: [] };
  }

  // ——— Ground deterministically (the law, independent of the model) ———
  const grounding = groundAnswerProposal(proposal, base.contextPack);
  const local = deterministicChecks(proposal, grounding, base.contextPack);

  // ——— Verify (AI audit, merged with the local checks) ———
  let report: VerificationFeedback = local;
  try {
    const verifyRaw = options.verificationProvider
      ? { available: true as const, raw: await options.verificationProvider(toVerifyRequest(base, proposal)), provider: "fixture" }
      : await getAiGateway().verifyAnswer(toVerifyRequest(base, proposal));

    if (verifyRaw.available) {
      const aiReport = parseVerificationProposal(verifyRaw.raw);
      report = mergeReports(local, aiReport);
    }
    // Verifier unavailable: the deterministic checks stand alone —
    // and the run stays honest about it (issues note it below).
  } catch {
    // A failed audit never passes silently: keep local checks only.
  }

  if (isVerificationValid(report)) {
    return {
      answer: {
        answer: proposal.answer,
        claims: grounding.claims,
        supportingMemoryIds: grounding.supportingMemoryIds,
        supportingMemoryCount: grounding.supportingMemoryIds.length,
        uncertainties: proposal.uncertainties,
        answerStyle: proposal.answer_style,
        verification: { status: "passed", issues: [] },
        source: "ai",
      },
      feedback: null,
      survivors: grounding.claims,
    };
  }

  return { answer: null, feedback: trimFeedback(report), survivors: grounding.claims };
}

function toVerifyRequest(
  base: Omit<GenerateAnswerRequest, "feedback">,
  proposal: AnswerProposal
): VerifyAnswerRequest {
  return {
    question: base.question,
    answer: {
      text: proposal.answer,
      claims: proposal.claims.map((claim) => ({
        text: claim.text,
        type: claim.type,
        memory_ids: claim.memory_ids,
      })),
      uncertainties: proposal.uncertainties,
      answer_style: proposal.answer_style,
    },
    contextPack: base.contextPack,
    currentDate: base.currentDate,
    timezone: base.timezone,
  };
}

/** AI report + deterministic checks: a problem listed anywhere is a problem. */
function mergeReports(local: VerificationFeedback, ai: VerificationFeedback): VerificationFeedback {
  return {
    valid: isVerificationValid(local) && isVerificationValid(ai),
    unsupported_claims: dedupe([...local.unsupported_claims, ...ai.unsupported_claims]),
    temporal_errors: dedupe([...local.temporal_errors, ...ai.temporal_errors]),
    entity_errors: dedupe([...local.entity_errors, ...ai.entity_errors]),
    source_mismatches: dedupe([...local.source_mismatches, ...ai.source_mismatches]),
    required_changes: dedupe([...local.required_changes, ...ai.required_changes]),
  };
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value !== ""))];
}

function trimFeedback(report: VerificationFeedback): VerificationFeedback {
  const first = (values: string[]) => values.slice(0, MAX_ISSUES_FOR_FEEDBACK);
  return {
    valid: report.valid,
    unsupported_claims: first(report.unsupported_claims),
    temporal_errors: first(report.temporal_errors),
    entity_errors: first(report.entity_errors),
    source_mismatches: first(report.source_mismatches),
    required_changes: first(report.required_changes),
  };
}

/* ————————————————— Conservative fallback (spec §7) ————————————————— */

/**
 * Loose text identity for the conservative composition: two claims
 * whose normalized texts are equal are the same statement for a reader.
 */
function normalizeClaimText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u064B-\u0652\u0670]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Two failed attempts: compose deterministically from the surviving
 * claims of the LATEST attempt (it had the verification feedback) —
 * cross-attempt merging is deliberately avoided: paraphrased retries
 * of the same claim would read as repetition. When nothing survives,
 * say the honest partial-evidence line — the retrieved memories remain
 * visible in the context pack.
 */
function conservativeAnswer(
  first: AttemptOutcome,
  second: AttemptOutcome,
  question: string
): ReasoningAnswer {
  const feedbacks = [first.feedback, second.feedback].filter(
    (feedback): feedback is VerificationFeedback => feedback !== null
  );
  const flaggedTexts = feedbacks.flatMap((feedback) => [
    ...feedback.unsupported_claims,
    ...feedback.source_mismatches,
  ]);
  const flagged = flaggedTexts.map((text) => text.toLowerCase());
  const isFlagged = (claimText: string) =>
    flagged.some((flag) => flag.includes(claimText.toLowerCase()) || claimText.toLowerCase().includes(flag));

  const keepSurvivors = (outcome: AttemptOutcome): GroundedClaim[] => {
    const kept: GroundedClaim[] = [];
    for (const claim of outcome.survivors) {
      if (isFlagged(claim.text)) continue;
      const normalized = normalizeClaimText(claim.text);
      if (normalized === "" || kept.some((existing) => normalizeClaimText(existing.text) === normalized)) continue;
      kept.push(claim);
    }
    return kept.filter((claim) => claim.type === "fact" || claim.memoryIds.length > 0);
  };

  // Latest attempt's survivors first; the first attempt's only when
  // the retry produced nothing usable at all.
  const claims = keepSurvivors(second).length > 0 ? keepSurvivors(second) : keepSurvivors(first);
  const supportingMemoryIds = [...new Set(claims.flatMap((claim) => claim.memoryIds))];

  const issues = feedbacks.flatMap((feedback) => [
    ...feedback.unsupported_claims,
    ...feedback.temporal_errors,
    ...feedback.entity_errors,
    ...feedback.source_mismatches,
  ]);

  if (claims.length === 0) {
    return {
      answer: partialEvidenceLine(question),
      claims: [],
      supportingMemoryIds: [],
      supportingMemoryCount: 0,
      uncertainties: [],
      answerStyle: "no_evidence",
      verification: { status: "conservative", issues: dedupe(issues).slice(0, MAX_ISSUES_FOR_FEEDBACK) },
      source: "deterministic",
    };
  }

  const answer = claims.map((claim) => claim.text).join(" ");
  return {
    answer,
    claims,
    supportingMemoryIds,
    supportingMemoryCount: supportingMemoryIds.length,
    uncertainties: [],
    answerStyle: "direct",
    verification: { status: "conservative", issues: dedupe(issues).slice(0, MAX_ISSUES_FOR_FEEDBACK) },
    source: "deterministic",
  };
}

/* ————————————————— Honest deterministic lines ————————————————— */

/** True when the text is dominantly Arabic script — for honest lines in the user's language. */
function isArabic(text: string): boolean {
  const arabic = text.match(/[\u0600-\u06FF]/g)?.length ?? 0;
  const latin = text.match(/[A-Za-z]/g)?.length ?? 0;
  return arabic > latin;
}

/** Spec §8: no evidence — never hallucinate. In the user's language. */
function noEvidenceLine(question: string): string {
  return isArabic(question)
    ? "مش لاقي حاجة في ذكرياتك المحفوظة تجاوب على السؤال ده. اللي بتحتفظ بيه هو اللي كِبت يقدر يلاقيه."
    : "I couldn't find anything in your saved memories that answers that. What you keep is what Kept can find.";
}

/** Spec §8: partial evidence — found related memories, not enough to answer. */
function partialEvidenceLine(question: string): string {
  return isArabic(question)
    ? "لقيت شوية ذكريات قريبة، بس مفيهاش معلومات كفاية أنا أطمن بيها على إجابة السؤال ده."
    : "I found a few related memories, but they don't contain enough information to answer that confidently.";
}

/**
 * Spec §28: reasoning failed after retrieval succeeded — expose the
 * memories, never invent. The pack's memories remain the answer
 * surface (the UI renders them alongside this line).
 */
function providerUnavailableAnswer(pack: ReasoningContextPack): ReasoningAnswer {
  return {
    answer: isArabic(pack.query)
      ? "جمعت الذكريات اللي ليها علاقة بالسؤال، ومعرفتش أوصلهم لجواب مكتوب دلوقتي. هايظهروا قدامك زي ما هم."
      : "I gathered the memories related to your question, but couldn't compose them into a written answer just now. They're below, exactly as you kept them.",
    claims: [],
    supportingMemoryIds: [],
    supportingMemoryCount: 0,
    uncertainties: [],
    answerStyle: "no_evidence",
    verification: { status: "deterministic", issues: [] },
    source: "deterministic",
  };
}
