import type { Metadata } from "next";
import { MicroLabel } from "@/components/shared/micro-label";

export const metadata: Metadata = {
  title: "Privacy, in plain words",
};

/**
 * /privacy — what this space stores and does, stated plainly.
 *
 * Product-level honesty, not legal boilerplate: what is stored, what
 * AI processing means here, how deletion and export work. No claims
 * beyond what the system actually does.
 */

const facts = [
  {
    label: "What is stored",
    text: "The memories you write — their words, titles, and dates — plus what the system notices in them: people, places, topics, and connections. Your account email and a hashed password. Nothing else, and nothing about anyone else.",
  },
  {
    label: "What AI processing is used for",
    text: "When you keep a memory, processing understands it: suggesting a title, noticing people and topics, connecting it to related memories. When you ask a question, the system gathers the few memories that could answer it and reads only those. It proposes; the application decides what is actually saved.",
  },
  {
    label: "What may reach the AI provider",
    text: "Only the minimum text needed for the operation at hand: the memory you just wrote, or the small set of memories relevant to your question, plus the request itself. Never another account's memories, never your password or session, never a full copy of the database.",
  },
  {
    label: "Who can see your memories",
    text: "You. Every query is scoped to your account — retrieving someone else's data is treated the same as asking for something that doesn't exist. There are no shared feeds, no rankings, no public pages.",
  },
  {
    label: "How deletion works",
    text: "Deleting a memory removes it, its history, and its connections. Deleting your account removes everything that belongs to it — memories, entities, conversations, sources, sessions — in one transactional sweep. Deletion is real, not a flag.",
  },
  {
    label: "How export works",
    text: "Settings → Data → Export produces a complete JSON file of your account: memories with their full history, entities, relations, sources, and conversations. Machine-readable, yours to keep, no asking required.",
  },
  {
    label: "What is logged",
    text: "Operational facts — that a request happened, how long it took, whether it failed. Not passwords, not session tokens, not the content of your memories.",
  },
];

export default function PrivacyPage() {
  return (
    <div className="mx-auto w-full max-w-2xl px-6">
      <div className="pb-24 pt-14 sm:pt-20">
        <MicroLabel>Privacy, in plain words</MicroLabel>
        <h1 className="mt-4 max-w-lg font-display text-3xl font-medium leading-tight text-foreground sm:text-4xl">
          A private place, described{" "}
          <em className="italic text-clay">honestly</em>.
        </h1>
        <p className="mt-4 max-w-lg text-[15px] leading-relaxed text-muted-foreground">
          Kept holds personal memories, so privacy is part of the product, not
          a policy afterthought. This page says what actually happens — the
          same facts the Settings page acts on.
        </p>

        <dl className="mt-14 space-y-10 border-t border-border/60 pt-12">
          {facts.map((fact) => (
            <div key={fact.label}>
              <dt>
                <MicroLabel as="h2">{fact.label}</MicroLabel>
              </dt>
              <dd className="mt-3 max-w-xl text-[15px] leading-relaxed text-foreground/90">
                {fact.text}
              </dd>
            </div>
          ))}
        </dl>

        <p className="mt-14 border-t border-border/60 pt-8 text-[13px] leading-relaxed text-muted-foreground">
          This page describes the product as built. It isn&apos;t legal
          advice, and it doesn&apos;t promise anything the system doesn&apos;t
          demonstrably do — the tests in the repository verify most of these
          sentences directly.
        </p>
      </div>
    </div>
  );
}
