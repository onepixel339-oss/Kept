/**
 * Deterministic fallback understanding — the honest floor.
 *
 * When the AI gateway cannot propose an understanding (unavailable,
 * throws, or returns untrusted output), the question is NEVER lost:
 * this module builds a conservative understanding from the user's own
 * words and their own entities. It uses only deterministic evidence:
 *
 *  - intent from question-word patterns (Arabic + English)
 *  - entity mentions: the user's own entity names that appear in the
 *    question (word-boundary safe, script-preserving)
 *  - topics: the user's topic entities whose names appear
 *  - time: resolveTimeExpression over the raw message
 *
 * It never invents: a name that matches no existing entity is not
 * fabricated — the words simply become keyword probes instead. The
 * entity retriever still resolves every mention through the entity
 * module's deterministic candidate ladder, with ambiguity preserved.
 */

import { listRecentEntities, normalizeNameDeep, transliterateToLatin } from "@/modules/entity";
import type { Entity } from "@/types/entity";
import type { QueryEntityMention, QueryTimeRange } from "@/types/query";
import { extractQueryTerms } from "./terms";
import { resolveTimeExpression } from "./time-resolution";
import type { QueryUnderstanding } from "./understanding";

/* ——— Intent patterns: question words → intent ——— */

const INTENT_PATTERNS: Array<{ intent: QueryUnderstanding["intent"]; pattern: RegExp }> = [
  { intent: "summary", pattern: /لخص|لخصلي|ملخص|summar\w*|recap/i },
  { intent: "timeline", pattern: /إمتى|امتى|متى|\bwhen\b|اول مرة|أول مرة|first time/i },
  { intent: "comparison", pattern: /قارن|قارنلي|الفرق|مقارنة|compare|difference|\bvs\b/i },
  { intent: "reflect", pattern: /علاقتي|اتغير|تغير|تطور|\bhow\b.*\bchang|changed?|over the (?:year|months)/i },
  { intent: "recall", pattern: /فاكر|تفتكر|افتكر|remember|recall/i },
  { intent: "explore", pattern: /ايه اللي حصل|إيه اللي حصل|what happened|احكيلي|tell me about|show me/i },
];

/** Classify the question's intent from its words; "find" is the neutral default. */
export function detectIntent(message: string): QueryUnderstanding["intent"] {
  for (const { intent, pattern } of INTENT_PATTERNS) {
    if (pattern.test(message)) return intent;
  }
  return "find";
}

/** Depth from intent: lookups are narrow, summaries and explorations broad. */
function depthForIntent(intent: QueryUnderstanding["intent"]): QueryUnderstanding["depth"] {
  switch (intent) {
    case "recall":
    case "timeline":
      return "narrow";
    case "summary":
    case "explore":
    case "reflect":
    case "comparison":
      return "broad";
    default:
      return "medium";
  }
}

/* ——— Name-in-message matching (word-boundary safe, script-preserving) ——— */

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Vowel-insensitive Latin key — the entity module's alias discipline. */
function looseLatinKey(value: string): string {
  return value.replace(/[aeiou]/g, "");
}

/**
 * Whether the question contains the entity's name — directly (same
 * script, word-boundary safe), or across scripts through the
 * conservative Arabic→Latin transliteration ladder (أحمد ↔ Ahmed),
 * word by word, vowel-insensitively. This is the SAME alias
 * comparison the entity module uses for resolution — never a fuzzier
 * cousin of it.
 */
function messageIncludesName(message: string, name: string): boolean {
  const normalizedMessage = normalizeProse(message);
  const normalized = normalizeProse(name);
  if (normalized === "") return false;

  const boundaryLeft = "(^|[^\\p{L}\\p{N}])";
  const boundaryRight = "(?=[^\\p{L}\\p{N}]|$)";

  if (new RegExp(`${boundaryLeft}${escapeRegExp(normalized)}${boundaryRight}`, "u").test(normalizedMessage)) {
    return true;
  }

  // Cross-script alias: compare transliterated, vowel-stripped keys.
  const entityLatinLoose = looseLatinKey(transliterateToLatin(name));
  if (entityLatinLoose !== "") {
    const words = normalizedMessage.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 1);
    for (const word of words) {
      const wordLatinLoose = looseLatinKey(transliterateToLatin(word));
      if (wordLatinLoose !== "" && wordLatinLoose === entityLatinLoose) {
        return true;
      }
    }
  }

  const deep = normalizeNameDeep(name);
  const firstWord = deep.split(" ")[0];
  if (firstWord !== "" && firstWord.length > 1) {
    return new RegExp(`${boundaryLeft}${escapeRegExp(firstWord)}${boundaryRight}`, "u").test(normalizedMessage);
  }
  return false;
}

function normalizeProse(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670]/g, "") // Arabic diacritics
    .replace(/\s+/g, " ")
    .trim();
}

/* ——— The fallback builder ——— */

/**
 * Build a conservative understanding without any AI call.
 */
export async function buildFallbackUnderstanding(
  message: string,
  userId: string,
  context: { currentDate: Date; timezone: string; scope: QueryUnderstanding["scope"] }
): Promise<QueryUnderstanding> {
  const intent = detectIntent(message);
  const depth = depthForIntent(intent);
  const needsReasoning = intent === "summary" || intent === "comparison" || intent === "reflect";

  // Entity mentions: the user's own names that appear in the question.
  const entities: Entity[] = await listRecentEntities(userId, 100);
  const mentions: QueryEntityMention[] = entities
    .filter((entity) => messageIncludesName(message, entity.name))
    .slice(0, 8)
    .map((entity) => ({ mention: entity.name, type: entity.type, qualifier: null }));

  // Topics: the user's topic entities whose names appear in the question.
  const topics = entities
    .filter((entity) => entity.type === "topic" && messageIncludesName(message, entity.name))
    .map((entity) => entity.name)
    .slice(0, 4);

  // Time: the deterministic resolver over the raw words.
  const resolved = resolveTimeExpression(message, context.currentDate, context.timezone);
  const time: QueryTimeRange = resolved
    ? {
        kind: resolved.kind,
        from: resolved.from?.toISOString() ?? null,
        to: resolved.to?.toISOString() ?? null,
        expression: null,
        uncertain: resolved.uncertain,
      }
    : { kind: "none", from: null, to: null, expression: null, uncertain: false };

  return {
    intent,
    mentions,
    topics,
    time,
    scope: context.scope,
    depth,
    needsReasoning,
  };
}

export { extractQueryTerms };
