/**
 * Chat intents — deterministic detection of the user's EXPLICIT
 * memory-mutation and meta requests inside a conversation (spec §16–18,
 * §24).
 *
 * The chat layer must never let a model decide to mutate memory, so
 * capture ("افتكر إني…") and deletion ("احذف…") are detected HERE,
 * from the user's own words, with imperative-anchored patterns that
 * cannot misfire on questions ("فاكر أحمد؟" is a question, not a
 * capture — the interrogative فاكر never matches the imperative
 * افتكر). Count questions ("كام ذكرى عندي؟") answer from the database
 * without any model.
 *
 * Detection is a GATE, not a decision: capture routes to the Memory
 * Orchestrator (which runs its normal validation pipeline), deletion
 * still requires an unambiguous target before the server performs it.
 */

/** Arabic normalization: strip diacritics/tatweel, unify alef forms. */
function normalizeAr(text: string): string {
  return text
    .replace(/[\u064B-\u0652\u0670\u0640]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .trim();
}

export type ChatIntentKind = "capture" | "deletion" | "count" | null;

export interface DetectedChatIntent {
  kind: ChatIntentKind;
  /** The matched trigger — provenance for the decision. */
  trigger: string | null;
}

/** Imperative capture openers (AR + EN). Anchor: start of message. */
const CAPTURE_AR = ["افتكر", "احفظ", "سجل", "خلي بالك", "خد بالك", "متنساش", "متنسيش", "دون"];
const CAPTURE_EN = /^(remember (this|that)\b|keep (this|that)\b|note that\b|don['’]t forget\b|do not forget\b)/i;

/** Imperative deletion openers (AR + EN). Anchor: start of message. */
const DELETION_AR = ["امسح", "احذف", "شيل", "الغي", "انسي"];
const DELETION_EN = /^(delete\b|remove\b|erase\b|forget (this|that|about)\b)/i;

/** Count-question markers + memory words. */
const COUNT_AR = ["كام", "عدد"];
const COUNT_EN = /how many/i;
const MEMORY_WORDS_AR = ["ذكري", "ذكريات", "مذكره"];
const MEMORY_WORD_EN = /memor(y|ies)/i;

/**
 * Detect the explicit intent of a chat message. Priority: capture →
 * deletion → count. Everything else is a question for the pipeline.
 */
export function detectChatIntent(rawMessage: string): DetectedChatIntent {
  const message = rawMessage.trim();
  const ar = normalizeAr(message);

  for (const trigger of CAPTURE_AR) {
    if (ar.startsWith(trigger)) {
      // "سجل/دون" can open non-capture sentences; require the capture
      // reading to be plausible: a following "إن/اني/إنني/en" or
      // possessive continuation. The unambiguous openers skip this.
      if ((trigger === "سجل" || trigger === "دون") && !/^(سجل|دون)\s*(عندك|لي|ان|إن)/.test(ar)) {
        continue;
      }
      return { kind: "capture", trigger };
    }
  }
  const enCapture = message.match(CAPTURE_EN);
  if (enCapture) return { kind: "capture", trigger: enCapture[0] };

  for (const trigger of DELETION_AR) {
    if (ar.startsWith(trigger)) return { kind: "deletion", trigger };
  }
  const enDeletion = message.match(DELETION_EN);
  if (enDeletion) return { kind: "deletion", trigger: enDeletion[0] };

  const hasMemoryWord =
    MEMORY_WORDS_AR.some((word) => ar.includes(word)) || MEMORY_WORD_EN.test(message);
  const hasCountMarker = COUNT_AR.some((word) => ar.includes(word)) || COUNT_EN.test(message);
  if (hasCountMarker && hasMemoryWord) {
    return { kind: "count", trigger: "count+memory" };
  }

  return { kind: null, trigger: null };
}

/** Convenience wrappers for the ask pipeline's routing. */
export function detectMemoryCapture(message: string): boolean {
  return detectChatIntent(message).kind === "capture";
}

export function detectDeletionRequest(message: string): boolean {
  return detectChatIntent(message).kind === "deletion";
}

export function detectCountQuestion(message: string): boolean {
  return detectChatIntent(message).kind === "count";
}
