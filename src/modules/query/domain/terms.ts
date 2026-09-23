/**
 * Query terms — deterministic keyword extraction for QUESTIONS.
 *
 * Distinct from the intelligence module's memory keyword extractor:
 * questions carry question words (إيه، فاكر، لخصلي، امتى) that must be
 * stripped before probing the database. Pure and deterministic — this
 * is the fallback path's engine and the keyword retriever's term
 * source; it never sees a model.
 */

import { queryConfig } from "@/config/query";

const QUESTION_STOPWORDS = new Set([
  // English function/question words
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "at", "for",
  "with", "about", "is", "was", "were", "are", "be", "been", "am", "do",
  "does", "did", "what", "whats", "when", "where", "who", "whos", "which",
  "how", "why", "did", "can", "could", "would", "should", "tell", "show",
  "find", "give", "remember", "know", "think", "any", "have", "has", "had",
  "me", "my", "we", "our", "you", "your", "i", "it", "its", "that", "this",
  "there", "then", "than", "so", "if", "not", "no", "from", "by", "as",
  // Egyptian Arabic question/high-frequency words
  "ايه", "إيه", "ايه", "مين", "فين", "امتى", "إمتى", "ازاي", "إزاي", "ليه",
  "فاكر", "تفتكر", "افتكر", "عاتد", "احكيلي", "احكيلى", "لخصلي", "لخص",
  "ملخص", "قوللي", "عايز", "عاوز", "ممكن", "لازم", "كده", "كدا", "ده",
  "دي", "دا", "اللي", "الذى", "التي", "الذي", "في", "فى", "من", "على",
  "عن", "مع", "هذا", "هذه", "ذلك", "كان", "كانت", "يكون", "قد", "لا",
  "ما", "ان", "أن", "إن", "او", "أو", "كل", "بعد", "قبل", "بيني", "وبين",
  "بين", "عندي", "عند", "معايا", "بتاع", "بتاعت", "بتوع", "تاع", "حصل",
  "حصلت", "حصلتلي", "بقى", "خلاص", "أول", "اول", "آخر", "اخر", "كل",
]);

/**
 * Extract probe terms from a question: normalized words minus
 * question/function words, frequency-ranked, bounded. Terms keep the
 * user's script (Arabic stays Arabic) so LIKE probes match the user's
 * own words in their memories.
 */
export function extractQueryTerms(message: string, max = queryConfig.budgets.maxKeywordTerms): string[] {
  const words = message
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length > 1 && !QUESTION_STOPWORDS.has(word));

  const frequency = new Map<string, number>();
  for (const word of words) {
    frequency.set(word, (frequency.get(word) ?? 0) + 1);
  }

  return [...frequency.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([word]) => word);
}
