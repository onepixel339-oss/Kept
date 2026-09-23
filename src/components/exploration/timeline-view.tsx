import Link from "next/link";
import { format } from "date-fns";
import { MicroLabel } from "@/components/shared/micro-label";
import type { TimelineYear } from "@/types/exploration";

/**
 * TimelineView — dated memories grouped by year and month.
 *
 * Reads like the index of a journal: a year, its months, and the
 * moments inside them in the order they happened. Every date shown is
 * the memory's own remembered date — memories without one are never
 * placed here (they are counted elsewhere, honestly).
 */
export function TimelineView({ years }: { years: TimelineYear[] }) {
  return (
    <div className="space-y-12">
      {years.map((year) => (
        <section key={year.year} aria-label={`Year ${year.year}`}>
          <h3 className="font-display text-xl font-medium text-foreground">{year.year}</h3>

          <div className="mt-5 space-y-8">
            {year.months.map((month) => (
              <div key={month.key}>
                <MicroLabel as="h4">{month.label}</MicroLabel>
                <ul className="mt-2 divide-y divide-border/60">
                  {month.entries.map((entry) => (
                    <li key={entry.memoryId}>
                      <Link
                        href={`/memories/${entry.memoryId}`}
                        className="group flex items-baseline gap-4 py-3.5"
                      >
                        <time
                          dateTime={entry.date.toISOString()}
                          className="w-14 shrink-0 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground/60"
                        >
                          {format(entry.date, "MMM d")}
                        </time>
                        <div className="min-w-0">
                          <p className="font-display text-[15px] font-medium leading-snug text-foreground transition-colors duration-200 group-hover:text-clay">
                            {entry.title ?? "Untitled"}
                          </p>
                          <p className="mt-0.5 line-clamp-1 text-[13px] leading-relaxed text-muted-foreground">
                            {entry.snippet}
                          </p>
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
