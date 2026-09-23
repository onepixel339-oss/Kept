/**
 * Answer proposal schemas — where reasoning output becomes trusted.
 *
 * Same discipline as the query module's understanding.ts and the
 * intelligence module's ai-schemas.ts: tolerate fences/prose around
 * the JSON, strip unknown fields, keep the vocabulary closed. A
 * proposal that cannot be parsed is a normal event — the reasoning
 * loop regenerates or falls back deterministically; it never lets
 * unvalidated model text reach the user or the conversation record.
 */

import { z } from "zod";
import { reasoningConfig } from "@/config/reasoning";

/* ————————————————— The proposal schemas ————————————————— */

export const ANSWER_STYLES = [
  "direct",
  "summary",
  "timeline",
  "comparison",
  "clarification",
  "no_evidence",
] as const;

export type AnswerStyle = (typeof ANSWER_STYLES)[number];

const claimSchema = z.object({
  text: z.string().min(1).max(reasoningConfig.maxClaimLength),
  type: z.enum(["fact", "inference"]),
  memory_ids: z.array(z.string().min(1).max(120)).max(reasoningConfig.maxMemoryIdsPerClaim),
});

export const answerProposalSchema = z.object({
  answer: z.string().min(1).max(reasoningConfig.maxAnswerLength),
  claims: z.array(claimSchema).max(reasoningConfig.maxClaims),
  uncertainties: z.array(z.string().min(1).max(400)).max(8),
  answer_style: z.enum(ANSWER_STYLES),
});

export type AnswerProposal = z.infer<typeof answerProposalSchema>;

export const verificationProposalSchema = z.object({
  valid: z.boolean(),
  unsupported_claims: z.array(z.string().min(1).max(600)).max(12),
  temporal_errors: z.array(z.string().min(1).max(600)).max(12),
  entity_errors: z.array(z.string().min(1).max(600)).max(12),
  source_mismatches: z.array(z.string().min(1).max(600)).max(12),
  required_changes: z.array(z.string().min(1).max(600)).max(12),
});

export type VerificationProposal = z.infer<typeof verificationProposalSchema>;

/* ————————————————— Parsing model output ————————————————— */

/**
 * Extract the JSON object from raw model output: tolerates markdown
 * fences and surrounding prose, same discipline as the other AI
 * boundary modules.
 */
export function extractJsonAnswer(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidate = fenced ? fenced[1] : trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    // Fall through: find the outermost braces.
  }

  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error("No JSON object found in the proposal.");
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

/** Parse a generated-answer proposal. Throws when it cannot be trusted. */
export function parseAnswerProposal(raw: string): AnswerProposal {
  const proposal = answerProposalSchema.parse(extractJsonAnswer(raw));

  // Normalize: trim texts, drop empties, dedupe ids per claim.
  const claims = proposal.claims
    .map((claim) => ({
      text: claim.text.trim(),
      type: claim.type,
      memory_ids: [...new Set(claim.memory_ids.map((id) => id.trim()).filter((id) => id !== ""))],
    }))
    .filter((claim) => claim.text !== "");

  const answer = proposal.answer.trim();
  if (answer === "") {
    throw new Error("The answer proposal is empty.");
  }

  return {
    answer,
    claims,
    uncertainties: [...new Set(proposal.uncertainties.map((u) => u.trim()).filter((u) => u !== ""))],
    answer_style: proposal.answer_style,
  };
}

/** Parse a verification report. Throws when it cannot be trusted. */
export function parseVerificationProposal(raw: string): VerificationProposal {
  return verificationProposalSchema.parse(extractJsonAnswer(raw));
}
