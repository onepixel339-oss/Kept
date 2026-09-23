/**
 * Grounding — the deterministic half of answer trust.
 *
 * The verification model is a second opinion; THIS module is the law.
 * Every claim is checked against the ContextPack it was generated
 * from, mechanically:
 *
 *  - memory ids that are not in the pack are fabricated provenance —
 *    discarded (the claim loses them; if a fact loses all of them it
 *    is unsupported),
 *  - a FACT claim with no surviving in-pack support is not a fact —
 *    it is demoted to an inference reading (interpretation) or, when
 *    it cannot honestly be one, dropped and reported,
 *  - "no_evidence" answers may not carry claims,
 *  - the supporting-memory set of the answer is exactly the union of
 *    surviving claim ids — never the whole pack.
 *
 * Same principle as Phase 3's model-reference filtering: the model can
 * only reference what was actually shown to it. Everything else is a
 * fabrication and is discarded before the user sees it.
 */

import type { ReasoningContextPack, VerificationFeedback } from "@/lib/ai";
import type { AnswerProposal } from "./answer-schemas";

/** A claim that survived grounding, with only real memory ids. */
export interface GroundedClaim {
  text: string;
  type: "fact" | "inference";
  memoryIds: string[];
}

export interface GroundingOutcome {
  claims: GroundedClaim[];
  /** Union of surviving claim memory ids — the answer's provenance. */
  supportingMemoryIds: string[];
  /** Deterministic problems found (feed the regeneration loop). */
  issues: string[];
}

export function groundAnswerProposal(
  proposal: AnswerProposal,
  pack: ReasoningContextPack
): GroundingOutcome {
  const packIds = new Set(pack.memories.map((memory) => memory.memoryId));
  const issues: string[] = [];
  const claims: GroundedClaim[] = [];

  const normalize = (text: string) =>
    text
      .toLowerCase()
      .replace(/[\u064B-\u0652\u0670]/g, "")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();

  for (const claim of proposal.claims) {
    // A claim that repeats an earlier one (the model restating itself)
    // adds no information and muddies provenance — drop it.
    const normalized = normalize(claim.text);
    if (normalized !== "" && claims.some((kept) => normalize(kept.text) === normalized)) {
      continue;
    }

    const realIds = claim.memory_ids.filter((id) => packIds.has(id));
    const fabricated = claim.memory_ids.length - realIds.length;

    if (fabricated > 0) {
      issues.push(
        `A claim cited ${fabricated} memory ${fabricated === 1 ? "id" : "ids"} not present in the retrieved context — discarded.`
      );
    }

    if (claim.type === "fact" && realIds.length === 0) {
      // A fact nobody's memory states: keep it only as a labeled
      // interpretation, never as fact.
      claims.push({ text: claim.text, type: "inference", memoryIds: [] });
      issues.push(`A claim stated as fact had no supporting memory — it was demoted to interpretation.`);
      continue;
    }

    claims.push({ text: claim.text, type: claim.type, memoryIds: realIds });
  }

  if (proposal.answer_style === "no_evidence" && claims.length > 0) {
    issues.push("The answer claimed no evidence but also made claims — the claims were dropped.");
    claims.length = 0;
  }

  const supportingMemoryIds = [
    ...new Set(claims.flatMap((claim) => claim.memoryIds)),
  ].filter((id) => packIds.has(id));

  return { claims, supportingMemoryIds, issues };
}

/**
 * Deterministic checks that run on EVERY attempt, independent of the
 * verification model: grounding issues, self-contradictions, and
 * style honesty. They merge into the verification report so a single
 * feedback shape reaches the regeneration step.
 */
export function deterministicChecks(
  proposal: AnswerProposal,
  grounding: GroundingOutcome,
  pack: ReasoningContextPack
): VerificationFeedback {
  const issues: VerificationFeedback = {
    valid: true,
    unsupported_claims: [],
    temporal_errors: [],
    entity_errors: [],
    source_mismatches: [],
    required_changes: [],
  };

  // Fabricated provenance is a source mismatch even after the id is
  // stripped — the regeneration should know not to re-cite it.
  const packIds = new Set(pack.memories.map((memory) => memory.memoryId));
  const citedIds = new Set(proposal.claims.flatMap((claim) => claim.memory_ids));
  for (const id of citedIds) {
    if (!packIds.has(id)) {
      issues.source_mismatches.push(`Cited memory "${id}" is not in the retrieved context.`);
    }
  }

  for (const issue of grounding.issues) {
    issues.required_changes.push(issue);
  }

  // An empty-context run must never produce a claims-bearing answer.
  if (pack.memories.length === 0 && proposal.claims.length > 0) {
    issues.unsupported_claims.push("The context contains no memories, so no factual claims are possible.");
  }

  // Temporal honesty: an answer that names a specific calendar date is
  // only as trustworthy as the pack's dates. When the pack carries no
  // real event dates (all proxies) but the answer asserts exact dates,
  // flag it. (The verification model catches semantic mismatches; this
  // catches the structural case deterministically.)
  const packHasRealDates = pack.memories.some((memory) => memory.rememberedAt !== null);
  if (!packHasRealDates && /\b(20\d{2}|19\d{2})\b/.test(proposal.answer)) {
    issues.temporal_errors.push(
      "The answer states a specific year, but the retrieved memories carry no event dates — only the days they were kept."
    );
  }

  issues.valid =
    issues.unsupported_claims.length === 0 &&
    issues.temporal_errors.length === 0 &&
    issues.entity_errors.length === 0 &&
    issues.source_mismatches.length === 0 &&
    issues.required_changes.length === 0;

  return issues;
}

/** True when nothing in the report objects. */
export function isVerificationValid(report: VerificationFeedback): boolean {
  return (
    report.valid &&
    report.unsupported_claims.length === 0 &&
    report.temporal_errors.length === 0 &&
    report.entity_errors.length === 0 &&
    report.source_mismatches.length === 0 &&
    report.required_changes.length === 0
  );
}
