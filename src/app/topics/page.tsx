import Link from "next/link";
import { FolderOpen } from "lucide-react";
import { EntitySummaryRow } from "@/components/exploration/entity-rows";
import { EmptyState } from "@/components/shared/empty-state";
import { MicroLabel } from "@/components/shared/micro-label";
import { requirePageUser } from "@/modules/user";
import { listTopics, ENTITY_PAGE_SIZE } from "@/modules/exploration";

/**
 * Topics — what your memories keep returning to.
 *
 * Topic and project entities that already exist in the memory system,
 * with quiet facts only: how many memories involve them, when they
 * were last active, and the people they involve. No descriptions are
 * invented — the memories speak for themselves.
 */

function pageHref(page: number): string {
  return page > 1 ? `/topics?page=${page}` : "/topics";
}

export default async function TopicsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const userId = (await requirePageUser()).id;

  const rawPage = typeof params.page === "string" ? Number.parseInt(params.page, 10) : 1;
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;

  const result = userId
    ? await listTopics(userId, { page, pageSize: ENTITY_PAGE_SIZE })
    : { topics: [], total: 0, page: 1, pageSize: ENTITY_PAGE_SIZE };

  const totalPages = Math.max(1, Math.ceil(result.total / result.pageSize));

  return (
    <div className="mx-auto w-full max-w-3xl px-6">
      <section className="pb-10 pt-14 sm:pt-16">
        <MicroLabel as="h1">Topics</MicroLabel>
        <p className="mt-3 font-display text-2xl font-medium text-foreground">
          {result.total > 0
            ? `${result.total} ${result.total === 1 ? "topic" : "topics"} in your memories`
            : "The topics in your memory"}
        </p>
        <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">
          Subjects and projects that keep appearing in what you write — gathered from your
          own words, with the people they involve.
        </p>
      </section>

      <section className="border-t border-border/60 pb-24 pt-10">
        {result.topics.length > 0 ? (
          <>
            <div className="divide-y divide-border/60">
              {result.topics.map((summary) => (
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
            icon={FolderOpen}
            title="No topics have emerged yet."
            description="When several memories touch the same subject or project, it will gather here."
          />
        )}
      </section>
    </div>
  );
}
