/**
 * Entity domain rules — pure functions for identity and vocabulary.
 *
 * Phase 2 resolution was deliberately modest: exact canonical matches
 * were reused, anything ambiguous left alone. Phase 3 extends the
 * deterministic toolkit (deep normalization, conservative alias
 * matching) while keeping the invariant: ambiguity is never silently
 * merged. AI may rank candidates; application logic decides.
 */

import { DEFAULT_ENTITY_ROLE, type EntityRole, type EntityType } from "@/types/entity";

/**
 * Normalize a name for exact matching: trim, collapse internal
 * whitespace, lowercase. "Ada Lovelace" and "ada  lovelace" are the
 * same entity; "ADA" and "Ada" are the same person.
 */
export function canonicalizeName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/* ————————————————— Deep normalization (Phase 3 entity resolution) ————————————————— */

/** Arabic diacritics (tashkeel) and tatweel — decorative, never identity. */
const ARABIC_MARKS = /[\u064B-\u0652\u0670\u0640]/g;

/**
 * Deep normalization for fuzzy-safe matching: Unicode NFKC, Arabic
 * letter unification (alef forms, taa marbuta, alef maqsura), diacritic
 * and tatweel removal, punctuation stripping, Latin casefolding.
 *
 * "أحمد" and "احمد" are the same name; "Café" and "cafe" are the same
 * place. This function is used ONLY to compare — the entity's stored
 * canonical name always comes from `canonicalizeName` of the original.
 */
export function normalizeNameDeep(name: string): string {
  let value = name.normalize("NFKC");
  value = value.replace(ARABIC_MARKS, "");
  value = value
    .replace(/[\u0623\u0625\u0622\u0671]/g, "\u0627") // أ إ آ ٱ → ا
    .replace(/\u0629/g, "\u0647") // ة → ه
    .replace(/\u0649/g, "\u064A"); // ى → ي
  value = value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return value;
}

/**
 * Conservative Arabic → Latin transliteration for alias comparison.
 * Deliberately crude and unambiguous: it exists to notice that
 * "أحمد" and "Ahmed" MAY be the same entity — never to assert that
 * they are. Used only as one more deterministic signal, always subject
 * to the ambiguity guards in the resolution layer.
 */
const ARABIC_TO_LATIN: Array<[RegExp, string]> = [
  [/[\u0623\u0625\u0622\u0627]/g, "a"], // alef forms → a
  [/\u0628/g, "b"],
  [/\u062A/g, "t"],
  [/\u062B/g, "th"],
  [/\u062C/g, "j"],
  [/\u062D/g, "h"],
  [/\u062E/g, "kh"],
  [/\u062F/g, "d"],
  [/\u0630/g, "dh"],
  [/\u0631/g, "r"],
  [/\u0632/g, "z"],
  [/\u0633/g, "s"],
  [/\u0634/g, "sh"],
  [/\u0635/g, "s"],
  [/\u0636/g, "d"],
  [/\u0637/g, "t"],
  [/\u0638/g, "z"],
  [/\u0639/g, "a"],
  [/\u063A/g, "gh"],
  [/\u0641/g, "f"],
  [/\u0642/g, "q"],
  [/\u0643/g, "k"],
  [/\u0644/g, "l"],
  [/\u0645/g, "m"],
  [/\u0646/g, "n"],
  [/\u0647/g, "h"],
  [/\u0648/g, "w"],
  [/\u064A/g, "y"],
  [/\u0626/g, "y"],
  [/\u0624/g, "w"],
  [/\u0621/g, ""], // hamza alone vanishes
];

/** Transliterate Arabic script to a rough Latin key, for alias matching only. */
export function transliterateToLatin(name: string): string {
  let value = normalizeNameDeep(name);
  if (!/[\u0600-\u06FF]/.test(value)) {
    return value; // no Arabic script — nothing to do
  }
  for (const [pattern, replacement] of ARABIC_TO_LATIN) {
    value = value.replace(pattern, replacement);
  }
  return value.replace(/\s+/g, " ").trim();
}

export const ENTITY_TYPE_VALUES: readonly EntityType[] = [
  "person",
  "place",
  "organization",
  "project",
  "topic",
  "object",
];

export const ENTITY_ROLE_VALUES: readonly EntityRole[] = [
  "participant",
  "subject",
  "location",
  "topic",
  "mentioned",
  "object",
];

export { DEFAULT_ENTITY_ROLE };
