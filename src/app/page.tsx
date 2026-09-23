import Link from "next/link";
import { ArrowRight, Bookmark } from "lucide-react";
import { MemoryInput } from "@/components/home/memory-input";
import { MemoryEntry } from "@/components/memory/memory-entry";
import { EmptyState } from "@/components/shared/empty-state";
import { MicroLabel } from "@/components/shared/micro-label";
import { requirePageUser } from "@/modules/user";
import { listMemories } from "@/modules/memory";
import { cn } from "@/lib/utils";

/**
 * Home — the opening page of the journal.
 *
 * One question, one quiet field, and — once something is kept — the
 * newest entries of the real archive below. No AI marketing language,
 * no statistics, no dashboard.
 */

const principles = [
  {
    label: "Keep",
    text: "Write moments, people, places, and ideas in your own words. The rest is taken care of.",
  },
  {
    label: "Rediscover",
    text: "What you keep gathers into people, topics, and a timeline you can wander through.",
  },
  {
    label: "Ask",
    text: "When you need something, ask in plain words — your own memory answers.",
  },
];

export default async function Home() {
  const userId = (await requirePageUser()).id;
  const recent = userId ? await listMemories(userId, { pageSize: 5 }) : null;
  const hasMemories = (recent?.items.length ?? 0) > 0;

  return (
    <div className="mx-auto w-full max-w-3xl px-6">
      {/* ————— The opening ————— */}
      <section
        className={cn(
          "pb-16 pt-16 sm:pb-20 sm:pt-24",
          "animate-in fade-in slide-in-from-bottom-2 duration-700"
        )}
      >
        <MicroLabel>A personal memory space</MicroLabel>

        <h1 className="mt-5 max-w-xl font-display text-4xl font-medium leading-[1.12] text-foreground sm:text-[2.75rem]">
          A quiet place to{" "}
          <em className="italic text-clay">keep</em> what matters.
        </h1>

        <p className="mt-5 max-w-lg text-[15px] leading-relaxed text-muted-foreground sm:text-base">
          Write things down the way you&apos;d tell a friend. Over time they
          gather into something you can search, wander, and ask — a memory
          that is yours alone.
        </p>

        <div className="mt-10">
          <MemoryInput />
        </div>
      </section>

      {/* ————— Recently kept ————— */}
      <section
        className={cn(
          "border-t border-border/60 pb-20 pt-12",
          "animate-in fade-in slide-in-from-bottom-2 duration-700 delay-150"
        )}
      >
        <div className="flex items-baseline justify-between">
          <MicroLabel as="h2">Recently kept</MicroLabel>
          {hasMemories && (
            <Link
              href="/memories"
              className="group inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground transition-colors duration-200 hover:text-foreground"
            >
              All {recent!.total}
              <ArrowRight
                aria-hidden="true"
                className="size-3 transition-transform duration-200 group-hover:translate-x-0.5"
              />
            </Link>
          )}
        </div>

        {hasMemories ? (
          <div className="mt-2 divide-y divide-border/60">
            {recent!.items.map((memory) => (
              <MemoryEntry key={memory.id} memory={memory} />
            ))}
          </div>
        ) : (
          <EmptyState
            icon={Bookmark}
            title="Nothing kept yet."
            description="The first thing you keep will begin your archive — a place that remembers for you."
            className="py-14 sm:py-16"
          />
        )}
      </section>

      {/* ————— The shape of the space ————— */}
      <section
        className={cn(
          "border-t border-border/60 pb-24 pt-12",
          "animate-in fade-in slide-in-from-bottom-2 duration-700 delay-300"
        )}
      >
        <div className="grid gap-10 sm:grid-cols-3 sm:gap-8">
          {principles.map((principle) => (
            <div key={principle.label}>
              <MicroLabel>{principle.label}</MicroLabel>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                {principle.text}
              </p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
