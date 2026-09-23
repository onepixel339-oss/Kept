import { MicroLabel } from "@/components/shared/micro-label";
import { AskBox } from "@/components/ask/ask-box";

/**
 * Ask — ask your memory a question, in your own words.
 *
 * Phase 5: real answers, written from the memories your question
 * retrieved — with their provenance ("Based on N memories") one quiet
 * line away. Explicit requests work too: "افتكر إني…" keeps a memory,
 * "احذف…" runs the existing deletion flow when the target is clear.
 * No chat bubbles, no AI dashboard: a question, an answer, and the
 * memories behind it.
 */
export default function AskPage() {
  return (
    <div className="mx-auto w-full max-w-3xl px-6">
      <section className="pb-10 pt-14 sm:pt-16">
        <MicroLabel as="h1">Ask</MicroLabel>
        <p className="mt-3 font-display text-2xl font-medium text-foreground">
          Ask about anything you&apos;ve kept.
        </p>
        <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">
          &ldquo;فاكر أحمد؟&rdquo; &ldquo;إيه اللي حصل بيني وبين أحمد بخصوص المشروع؟&rdquo;
          &ldquo;لخصلي الشهر اللي فات.&rdquo; — ask in your own words. Kept answers from what you
          actually wrote, and shows the memories behind every answer. When the memories don&apos;t
          hold something, it says so.
        </p>
      </section>

      <section className="border-t border-border/60 pb-24 pt-10">
        <AskBox />
      </section>
    </div>
  );
}
