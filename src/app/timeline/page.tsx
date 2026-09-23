import Link from "next/link";
import { CalendarClock } from "lucide-react";
import { AskBox } from "@/components/ask/ask-box";
import { EmptyState } from "@/components/shared/empty-state";
import { TimelineView } from "@/components/exploration/timeline-view";
import { MicroLabel } from "@/components/shared/micro-label";
import { requirePageUser } from "@/modules/user";
import { getTimeline, MEMORY_PAGE_SIZE } from "@/modules/exploration";
import { isTopicEntity } from "@/lib/entity-links";
import type { EntityType } from "@/types/entity";

/**
 * Timeline — what happened, in the order it happened.
 *
 * Built from the dates memories actually carry. A memory without a
 * known date is never placed here with an invented one — it is
 * counted, quietly, and stays reachable through search, related
 * memories, and its own page. Asking about a period uses the global
 * ask pipeline; the planner handles the time range (spec §14).
 */

const PAGE_SIZE = MEMORY_PAGE_SIZE;

function pageHref(page: number, entityId: string | null): string {
  const params = new URLSearchParams();
  if (entityId) params.set("entity", entityId);
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `/timeline?${query}` : "/timeline";
}

export default async function TimelinePage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const userId = (await requirePageUser()).id;

  const rawPage = typeof params.page === "string" ? Number.parseInt(params.page, 10) : 1;
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
  const entityId = typeof params.entity === "string" ? params.entity : null;

  const data = userId
    ? await getTimeline(userId, { entityId, page, pageSize: PAGE_SIZE })
    : {
        years: [],
        total: 0,
        page: 1,
        pageSize: PAGE_SIZE,
        undatedCount: 0,
        filteredEntity: null,
      };

  const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const filterType = data.filteredEntity
    ? isTopicEntity(data.filteredEntity.type)
      ? "topic"
      : (data.filteredEntity.type as EntityType)
    : null;

  const heading = data.filteredEntity
    ? `Memories involving ${data.filteredEntity.name}`
    : data.total > 0
      ? `${data.total} ${data.total === 1 ? "memory" : "memories"} with dates`
      : "Your timeline";

  return (
    <div className="mx-auto w-full max-w-3xl px-6">
      <section className="pb-10 pt-14 sm:pt-16">
        <MicroLabel as="h1">Timeline</MicroLabel>
        <p className="mt-3 font-display text-2xl font-medium text-foreground">{heading}</p>
        <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">
          {data.filteredEntity
            ? `Only the dated memories that involve this ${filterType}.`
            : "Moments with known dates, month by month. Memories you dated yourself — Kept doesn't invent dates that were never given."}
        </p>

        {/* Filter state — quiet, with a way out. */}
        {data.filteredEntity && (
          <p className="mt-4 inline-flex items-center gap-3 rounded-full border border-border bg-card px-3.5 py-1.5 text-[13px] text-foreground shadow-xs">
            <span>
              {data.filteredEntity.name}
              <span className="ml-2 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground/60">
                {filterType}
              </span>
            </span>
            <Link
              href="/timeline"
              className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground underline decoration-border underline-offset-4 transition-colors hover:text-foreground hover:decoration-clay"
            >
              Clear
            </Link>
          </p>
        )}
      </section>

      <section className="border-t border-border/60 pb-16 pt-10">
        {data.years.length > 0 ? (
          <>
            <TimelineView years={data.years} />

            {totalPages > 1 && (
              <nav
                aria-label="Pagination"
                className="mt-12 flex items-center justify-between font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground"
              >
                {data.page > 1 ? (
                  <Link
                    href={pageHref(data.page - 1, data.filteredEntity?.id ?? null)}
                    className="transition-colors hover:text-foreground"
                  >
                    ← Newer
                  </Link>
                ) : (
                  <span className="opacity-40">← Newer</span>
                )}
                <span>
                  Page {data.page} of {totalPages}
                </span>
                {data.page < totalPages ? (
                  <Link
                    href={pageHref(data.page + 1, data.filteredEntity?.id ?? null)}
                    className="transition-colors hover:text-foreground"
                  >
                    Older →
                  </Link>
                ) : (
                  <span className="opacity-40">Older →</span>
                )}
              </nav>
            )}
          </>
        ) : data.filteredEntity ? (
          <EmptyState
            icon={CalendarClock}
            title="Nothing dated involves this yet."
            description="When a memory that involves them carries a date, it will appear here."
          />
        ) : (
          <EmptyState
            icon={CalendarClock}
            title="There aren't enough dated memories to build a timeline yet."
            description="When a memory carries a date — “January 10”, “last summer” — it will gather here, month by month."
          />
        )}

        {/* Honest note about undated memories — never fabricated onto the timeline. */}
        {data.undatedCount > 0 && (
          <p className="mt-12 border-t border-border/60 pt-6 font-mono text-[10px] uppercase leading-relaxed tracking-[0.14em] text-muted-foreground/50">
            {data.undatedCount} {data.undatedCount === 1 ? "memory has" : "memories have"} no
            known date — {data.undatedCount === 1 ? "it stays" : "they stay"} in search and
            related memories rather than being placed here.
          </p>
        )}
      </section>

      {/* ————— Ask about this period (spec §14: the planner handles time) ————— */}
      <section className="border-t border-border/60 pb-24 pt-8">
        <MicroLabel as="h2">Ask about this period</MicroLabel>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">
          &ldquo;إيه اللي حصل في مارس؟&rdquo; &ldquo;What happened during{" "}
          {data.years[0]?.months[0]?.label ?? "last month"}?&rdquo; — ask in your own words;
          the same retrieval engine that powers Ask finds the memories.
        </p>
        <div className="mt-6">
          <AskBox placeholder="Ask about a moment or a month…" />
        </div>
      </section>
    </div>
  );
}
