/**
 * Query understanding — the schema where model output becomes trusted.
 *
 * The AI proposes a structured understanding of the user's question.
 * This module validates that proposal (zod), normalizes it (dates,
 * unknown fields stripped, impossible windows repaired), and reports
 * WHY it rejected a proposal when it does. A rejected proposal is a
 * normal event, not an error: the pipeline falls back to the
 * deterministic understanding built from the user's own words.
 *
 * Same discipline as the intelligence module's ai-schemas: tolerate
 * fences/prose around the JSON, strip unknown fields, keep the
 * vocabulary closed.
 */

import { z } from "zod";
import { ENTITY_TYPES } from "@/types/entity";
import { QUERY_DEPTHS, QUERY_INTENTS, QUERY_SCOPES } from "@/types/query";
import type { QueryEntityMention, QueryTimeRange } from "@/types/query";
import { resolveTimeExpression, normalizeResolvedWindow } from "./time-resolution";

/* ————————————————— The proposal schema ————————————————— */

const timeRangeSchema = z.object({
  kind: z.enum(["none", "exact", "range", "month", "year", "relative", "before", "after"]),
  from: z.string().nullable(),
  to: z.string().nullable(),
  expression: z.string().nullable(),
  uncertain: z.boolean(),
});

const mentionSchema = z.object({
  mention: z.string().min(1).max(120),
  type: z.enum(ENTITY_TYPES).nullable(),
  qualifier: z.string().max(120).nullable().optional(),
  /** An UNTRUSTED hint: which saved entity the mention may refer to.
   *  Validated against the run's known-entity list before any use. */
  entity_id: z.string().max(120).nullable().optional(),
});

export const queryUnderstandingProposalSchema = z.object({
  intent: z.enum(QUERY_INTENTS),
  entities: z.array(mentionSchema).max(8),
  topics: z.array(z.string().min(1).max(80)).max(8),
  time: timeRangeSchema,
  scope: z.enum(QUERY_SCOPES),
  depth: z.enum(QUERY_DEPTHS),
  needs_reasoning: z.boolean(),
});

export type QueryUnderstandingProposal = z.infer<typeof queryUnderstandingProposalSchema>;

/* ————————————————— Parsing model output ————————————————— */

/**
 * Extract the JSON object from raw model output: tolerates markdown
 * fences and surrounding prose, same discipline as the intelligence
 * module's parseProposal.
 */
function extractJson(raw: string): unknown {
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

/* ————————————————— The validated understanding ————————————————— */

/** A validated, normalized understanding of one question. */
export interface QueryUnderstanding {
  intent: (typeof QUERY_INTENTS)[number];
  mentions: QueryEntityMention[];
  topics: string[];
  time: QueryTimeRange;
  scope: (typeof QUERY_SCOPES)[number];
  depth: (typeof QUERY_DEPTHS)[number];
  needsReasoning: boolean;
}

export interface ParsedUnderstanding {
  understanding: QueryUnderstanding;
}

/**
 * Parse and validate a raw proposal. Throws when the proposal cannot
 * be trusted — the caller falls back to deterministic understanding.
 *
 * Normalization performed here:
 *  - mentions are trimmed; empty mentions dropped
 *  - AI-proposed windows are cross-checked: unparseable dates become
 *    null + uncertain; from > to is swapped; the user's expression
 *    is preserved
 *  - relative windows proposed by the model are RE-RESOLVED
 *    deterministically from the expression when possible, so the
 *    system's dates come from its own clock math, not the model's
 */
export function parseQueryUnderstanding(
  raw: string,
  context: { currentDate: Date; timezone: string }
): QueryUnderstanding {
  const proposal = queryUnderstandingProposalSchema.parse(extractJson(raw));

  const mentions: QueryEntityMention[] = [];
  const seenMentions = new Set<string>();
  for (const entity of proposal.entities) {
    const mention = entity.mention.trim();
    if (mention === "") continue;
    const key = mention.toLowerCase();
    if (seenMentions.has(key)) continue;
    seenMentions.add(key);
    mentions.push({
      mention,
      type: entity.type,
      qualifier: entity.qualifier?.trim() || null,
      entityId: entity.entity_id?.trim() || null,
    });
  }

  const topics = [...new Set(proposal.topics.map((topic) => topic.trim()).filter((t) => t !== ""))];

  const time = normalizeTimeWindow(proposal.time, context);

  return {
    intent: proposal.intent,
    mentions,
    topics,
    time,
    scope: proposal.scope,
    depth: proposal.depth,
    needsReasoning: proposal.needs_reasoning,
  };
}

/**
 * Normalize a proposed time window against the system's own clock.
 * Relative expressions are re-resolved deterministically; unparseable
 * dates degrade to uncertainty — never fabricated precision.
 */
function normalizeTimeWindow(
  proposed: QueryUnderstandingProposal["time"],
  context: { currentDate: Date; timezone: string }
): QueryTimeRange {
  const expression = proposed.expression?.trim() || null;

  if (proposed.kind === "none" || (!proposed.from && !proposed.to && proposed.kind !== "after" && proposed.kind !== "before")) {
    // No usable window proposed. Try the expression once — the model
    // sometimes reports the kind as none while quoting a usable phrase.
    if (expression) {
      const resolved = resolveTimeExpression(expression, context.currentDate, context.timezone);
      if (resolved) return normalizeResolvedWindow(resolved, expression);
    }
    return { kind: "none", from: null, to: null, expression, uncertain: Boolean(expression) };
  }

  // Relative expressions: the deterministic resolver is the authority.
  if (proposed.kind === "relative" && expression) {
    const resolved = resolveTimeExpression(expression, context.currentDate, context.timezone);
    if (resolved) return normalizeResolvedWindow(resolved, expression);
    return { kind: "relative", from: null, to: null, expression, uncertain: true };
  }

  let from = parseIsoOrNull(proposed.from);
  let to = parseIsoOrNull(proposed.to);

  if (from && to && from > to) {
    [from, to] = [to, from];
  }

  // A half-open window whose only date failed to parse degrades honestly.
  if (!from && !to) {
    return { kind: proposed.kind, from: null, to: null, expression, uncertain: true };
  }

  return {
    kind: proposed.kind,
    from: from?.toISOString() ?? null,
    to: to?.toISOString() ?? null,
    expression,
    uncertain: proposed.uncertain,
  };
}

function parseIsoOrNull(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
