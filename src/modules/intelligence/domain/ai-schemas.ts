/**
 * AI output schemas — the boundary where model output becomes trustworthy.
 *
 * Everything the provider returns is a raw JSON string. These zod
 * schemas are the ONLY way a proposal may proceed: unknown fields are
 * stripped, vocabularies are enforced, confidences are bounded, and
 * anything malformed is rejected. A schema violation is a safe,
 * recorded failure — never a partial write.
 *
 * These schemas are domain logic on purpose: what counts as a valid
 * proposal is a decision about THIS product, not a property of the
 * provider.
 */

import { z } from "zod";
import { MEMORY_TYPES } from "@/types/memory";
import { ENTITY_ROLES, ENTITY_TYPES } from "@/types/entity";

/** Confidence: a number in [0, 1]. The model may try to exceed it; it may not. */
const confidence = z.number().min(0).max(1);

export const analysisEntitySchema = z.object({
  type: z.enum(ENTITY_TYPES),
  name: z.string().trim().min(1).max(120),
  role: z.enum(ENTITY_ROLES),
  confidence,
});

export const analysisTimeSchema = z.object({
  mentioned_text: z.string().trim().max(200).nullable(),
  /** "YYYY-MM-DD" or ISO datetime — coerced to a Date by the applier. */
  normalized: z.string().trim().max(40).nullable(),
  confidence,
});

export const candidateSchema = z.object({
  type: z.enum(MEMORY_TYPES),
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(2_000),
  confidence,
  entities: z.array(analysisEntitySchema).max(8),
  time: analysisTimeSchema,
  facts: z.array(z.string().trim().min(1).max(500)).max(10),
  thoughts: z.array(z.string().trim().min(1).max(500)).max(10),
  opinion_only: z.boolean(),
  insufficient_content: z.boolean(),
});

export const analysisProposalSchema = z.object({
  candidate: candidateSchema,
});

export type AnalysisProposal = z.infer<typeof analysisProposalSchema>;
export type CandidateProposal = z.infer<typeof candidateSchema>;

const memoryIdRef = z.string().min(1).max(64);

export const comparisonMatchSchema = z.object({
  memory_id: memoryIdRef,
  relationship: z.enum([
    "related",
    "follows",
    "continuation",
    "same_event",
    "state_change",
    "contradiction",
  ]),
  confidence,
  evidence: z.string().trim().max(500).default(""),
});

export const comparisonEntityMatchSchema = z.object({
  name: z.string().trim().min(1).max(120),
  entity_id: memoryIdRef,
  confidence,
});

export const comparisonUpdateSchema = z.object({
  memory_id: memoryIdRef,
  reason: z.string().trim().max(500).default(""),
  confidence,
});

export const comparisonRelationSchema = z.object({
  source: z.object({ type: z.enum(ENTITY_TYPES), name: z.string().trim().min(1).max(120) }),
  relation_type: z.enum(["participates_in", "related_to"]),
  target: z.object({ type: z.enum(ENTITY_TYPES), name: z.string().trim().min(1).max(120) }),
  confidence,
});

export const comparisonProposalSchema = z.object({
  matches: z.array(comparisonMatchSchema).max(10),
  entity_matches: z.array(comparisonEntityMatchSchema).max(10),
  updates: z.array(comparisonUpdateSchema).max(5),
  conflicts: z.array(comparisonUpdateSchema).max(5),
  merge_candidates: z.array(comparisonUpdateSchema).max(5),
  new_relations: z.array(comparisonRelationSchema).max(5),
});

export type ComparisonProposal = z.infer<typeof comparisonProposalSchema>;

/** Failure modes recorded when a proposal does not survive validation. */
export type ProposalRejection =
  | { kind: "unparseable"; detail: string }
  | { kind: "schema"; detail: string };

/**
 * Parse raw provider output into a validated proposal. Tolerates the
 * usual model habits (markdown fences, leading prose) by extracting
 * the outermost JSON object, then enforces the schema strictly.
 */
export function parseProposal<T>(raw: string, schema: z.ZodType<T>): { ok: true; value: T } | { ok: false; rejection: ProposalRejection } {
  const extracted = extractJson(raw);
  if (!extracted.ok) {
    return { ok: false, rejection: { kind: "unparseable", detail: extracted.detail } };
  }
  const parsed = schema.safeParse(extracted.value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const detail = issue
      ? `${issue.path.join(".") || "root"}: ${issue.message}`
      : "The proposal did not match the expected structure.";
    return { ok: false, rejection: { kind: "schema", detail } };
  }
  return { ok: true, value: parsed.data };
}

/** Extract the outermost JSON object from noisy model output. */
function extractJson(raw: string): { ok: true; value: unknown } | { ok: false; detail: string } {
  const text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], text].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end <= start) continue;
    try {
      return { ok: true, value: JSON.parse(candidate.slice(start, end + 1)) };
    } catch {
      // Try the next candidate slice before giving up.
    }
  }
  return { ok: false, detail: "The response did not contain readable JSON." };
}
