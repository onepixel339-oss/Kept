import { Users } from "lucide-react";
import { EntitySummaryRow } from "@/components/exploration/entity-rows";
import { EmptyState } from "@/components/shared/empty-state";
import { MicroLabel } from "@/components/shared/micro-label";
import { requirePageUser } from "@/modules/user";
import { listPeople, ENTITY_PAGE_SIZE } from "@/modules/exploration";
import Link from "next/link";

/**
 * People — the index of who lives in your memory.
 *
 * Everyone your memories mention, with quiet facts only: how many
 * memories involve them, when they were last kept, and the topics
 * they appear alongside. Derived entirely from stored memory data —
 * no biographies are invented, nothing is ranked.
 */

function pageHref(page: number): string {
  return page > 1 ? `/people?page=${page}` : "/people";
}

export default async function PeoplePage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const userId = (await requirePageUser()).id;

  const rawPage = typeof params.page === "string" ? Number.parseInt(params.page, 10) : 1;
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;

  const result = userId
    ? await listPeople(userId, { page, pageSize: ENTITY_PAGE_SIZE })
    : { people: [], total: 0, page: 1, pageSize: ENTITY_PAGE_SIZE };

  const totalPages = Math.max(1, Math.ceil(result.total / result.pageSize));

  return (
    <div className="mx-auto w-full max-w-3xl px-6">
      <section className="pb-10 pt-14 sm:pt-16">
        <MicroLabel as="h1">People</MicroLabel>
        <p className="mt-3 font-display text-2xl font-medium text-foreground">
          {result.total > 0
            ? `${result.total} ${result.total === 1 ? "person" : "people"} in your memories`
            : "The people in your memory"}
        </p>
        <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">
          Everyone your memories mention, gathered from your own words. Open a name to see
          the memories, the topics they touch, and their timeline.
        </p>
      </section>

      <section className="border-t border-border/60 pb-24 pt-10">
        {result.people.length > 0 ? (
          <>
            <div className="divide-y divide-border/60">
              {result.people.map((summary) => (
                <EntitySummaryRow key={summary.entity.id} summary={summary} />
              ))}
            </div>

            {totalPages > 1 && (
              <nav
                aria-label="Pagination"
                className="mt-10 flex items-center justify-between font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground"
              >
                {result.page > 1 ? (
                  <Link
                    href={pageHref(result.page - 1)}
                    className="transition-colors hover:text-foreground"
                  >
                    ← Previous
                  </Link>
                ) : (
                  <span className="opacity-40">← Previous</span>
                )}
                <span>
                  Page {result.page} of {totalPages}
                </span>
                {result.page < totalPages ? (
                  <Link
                    href={pageHref(result.page + 1)}
                    className="transition-colors hover:text-foreground"
                  >
                    Next →
                  </Link>
                ) : (
                  <span className="opacity-40">Next →</span>
                )}
              </nav>
            )}
          </>
        ) : (
          <EmptyState
            icon={Users}
            title="You haven't saved memories mentioning people yet."
            description="When a memory involves someone — a meeting, a message, a shared moment — they'll gather here."
          />
        )}
      </section>
    </div>
  );
}
