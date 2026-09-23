/**
 * Honest lines — what the user reads when no model is involved.
 *
 * Every deterministic response the ask pipeline can give lives here so
 * the honesty rules (spec §8, §16–18, §24) are one reviewable surface:
 * no-evidence, partial-evidence, provider-failure, counts, listings,
 * capture acknowledgements, deletion outcomes. Each answers in the
 * question's language (Arabic script detection — no model call), each
 * says only what actually happened.
 */

import type { ReasoningAnswer } from "../application/reasoning-service";
import type { AnswerStyle } from "./answer-schemas";

/** True when the text is dominantly Arabic script. */
export function isArabicQuestion(text: string): boolean {
  const arabic = text.match(/[\u0600-\u06FF]/g)?.length ?? 0;
  const latin = text.match(/[A-Za-z]/g)?.length ?? 0;
  return arabic > latin;
}

function line(
  question: string,
  answerAr: string,
  answerEn: string,
  style: AnswerStyle,
  extras: Partial<ReasoningAnswer> = {}
): ReasoningAnswer {
  return {
    answer: isArabicQuestion(question) ? answerAr : answerEn,
    claims: [],
    supportingMemoryIds: [],
    supportingMemoryCount: 0,
    uncertainties: [],
    answerStyle: style,
    verification: { status: "deterministic", issues: [] },
    source: "deterministic",
    ...extras,
  };
}

/** Spec §8: the pack is empty — never hallucinate an answer. */
export function noEvidenceAnswer(question: string): ReasoningAnswer {
  return line(
    question,
    "مش لاقي حاجة في ذكرياتك المحفوظة تجاوب على السؤال ده. اللي بتحتفظ بيه هو اللي كِبت يقدر يلاقيه.",
    "I couldn't find anything in your saved memories that answers that. What you keep is what Kept can find.",
    "no_evidence"
  );
}

/** Spec §8: related memories exist, but they don't answer confidently. */
export function partialEvidenceAnswer(question: string): ReasoningAnswer {
  return line(
    question,
    "لقيت شوية ذكريات قريبة، بس مفيهاش معلومات كفاية أنا أطمن بيها على إجابة السؤال ده.",
    "I found a few related memories, but they don't contain enough information to answer that confidently.",
    "no_evidence"
  );
}

/** Spec §28: retrieval succeeded, reasoning failed — show the memories, invent nothing. */
export function reasoningFailedAnswer(question: string, memoryCount: number): ReasoningAnswer {
  return line(
    question,
    `جمعت ${memoryCount} ${memoryCount === 1 ? "ذكرى" : "ذكريات"} ليها علاقة بالسؤال، ومعرفتش أوصلهم لجواب مكتوب دلوقتي. هايظهروا قدامك زي ما حفظتهم بالظبط.`,
    `I gathered ${memoryCount} ${memoryCount === 1 ? "memory" : "memories"} related to your question, but couldn't compose them into a written answer just now. They're below, exactly as you kept them.`,
    "no_evidence"
  );
}

/** Spec §24: count questions answer from the database, not a model. */
export function countAnswer(question: string, count: number, windowed: boolean): ReasoningAnswer {
  if (windowed) {
    return line(
      question,
      `حسبت ${count} ${count === 1 ? "ذكرى" : "ذكرى"} في الفترة الزمنية دي من ذكرياتك.`,
      `I count ${count} ${count === 1 ? "memory" : "memories"} in that time window of yours.`,
      "direct"
    );
  }
  return line(
    question,
    `عندك ${count} ${count === 1 ? "ذكرى محفوظة" : "ذكريات محفوظة"}.`,
    `You have ${count} ${count === 1 ? "memory" : "memories"} kept.`,
    "direct"
  );
}

/** Spec §24: pure structured listings answer from the retrieval result. */
export function listAnswer(question: string, memoryIds: string[]): ReasoningAnswer {
  const count = memoryIds.length;
  return line(
    question,
    `دي ${count === 1 ? "الذكرى" : "الذكريات"} اللي لقيتها عندك — ${count} ${count === 1 ? "واحدة" : ""}:`.replace(" — :", ":"),
    `Here ${count === 1 ? "is" : "are"} the ${count === 1 ? "memory" : "memories"} I found — ${count}:`,
    "direct",
    { supportingMemoryIds: memoryIds, supportingMemoryCount: count }
  );
}

/** Spec §17: explicit capture is acknowledged honestly (the pipeline runs after). */
export function captureAnswer(question: string, title: string | null): ReasoningAnswer {
  return line(
    question,
    `اتحفظت${title ? ` باسم «${title}»` : ""}. بقت في ذكرياتك، وهتتعامل معاها زي أي حاجة حفظتها.`,
    `Kept${title ? ` as “${title}”` : ""}. It's in your memories now, handled like everything else you keep.`,
    "direct"
  );
}

/** Spec §18: an explicit, unambiguous deletion was performed by the server. */
export function deletedAnswer(question: string, title: string | null): ReasoningAnswer {
  return line(
    question,
    `اتمسحت${title ? ` «${title}»` : " الذكرى"} من أرشيفك. ده إجراء نهائي — اللي كان مربوط بيها اتمسح معاها، وأسماء الناس والأشياء نفسها فضلت محفوظة.`,
    `Deleted${title ? ` “${title}”` : " the memory"} from your archive. That's permanent — what was attached to it went with it; the people and things themselves remain.`,
    "direct"
  );
}

/** Spec §15/§18: ambiguous target — ask, never guess. */
export function clarificationAnswer(question: string, whatAr: string, whatEn: string): ReasoningAnswer {
  return line(question, whatAr, whatEn, "clarification");
}
