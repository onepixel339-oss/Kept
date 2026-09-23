import Link from "next/link";
import { Bookmark, Search } from "lucide-react";
import { MemoryEntry } from "@/components/memory/memory-entry";
import { EmptyState } from "@/components/shared/empty-state";
import { MicroLabel } from "@/components/shared/micro-label";
import { Button } from "@/components/ui/button";
import { requirePageUser } from "@/modules/user";
import { listMemories } from "@/modules/memory";
import { getDiscovery } from "@/modules/exploration";
import { entityHrefFromParts } from "@/lib/entity-links";
import { cn } from "@/lib/utils";

/**
 * Memories — the archive itself.
 *
 * Everything the user has kept, newest first, with an ordinary
 * database search (title and content). No semantic search yet — that
 * honesty is the product's, too.
 */

const PAGE_SIZE = 20;

function pageHref(q: string | undefined, page: number): string {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `/memories?${query}` : "/memories";
}

export default async function MemoriesPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const userId = (await requirePageUser()).id;

  const q = typeof params.q === "string" ? params.q : undefined;
  const rawPage = typeof params.page === "string" ? Number.parseInt(params.page, 10) : 1;
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;

  const result = userId
    ? await listMemories(userId, { q, page, pageSize: PAGE_SIZE })
    : { items: [], total: 0, page: 1, pageSize: PAGE_SIZE };

  // The quiet discovery strip: who and what your memories mention.
  // Descriptive counts only — never a ranking of your life.
  const discovery = userId && result.total > 0 ? await getDiscovery(userId) : null;

  const totalPages = Math.max(1, Math.ceil(result.total / PAGE_SIZE));
  const isSearching = Boolean(q);

  return (
    <div className="mx-auto w-full max-w-3xl px-6">
      <section className="pb-10 pt-14 sm:pt-16">
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div>
            <MicroLabel as="h1">Memories</MicroLabel>
            <p className="mt-3 font-display text-2xl font-medium text-foreground">
              {isSearching
                ? `${result.total} ${result.total === 1 ? "match" : "matches"}`
                : `${result.total} ${result.total === 1 ? "memory" : "memories"} kept`}
            </p>
          </div>

          {/* Ordinary database search — honest about what it is. */}
          <form action="/memories" method="GET" className="flex w-full items-center gap-2 sm:w-72">
            <label htmlFor="memories-search" className="sr-only">
              Search memories
            </label>
            <div className="relative flex-1">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/50"
              />
              <input
                id="memories-search"
                name="q"
                type="search"
                defaultValue={q ?? ""}
                placeholder="Search title or words…"
                className={cn(
                  "h-9 w-full rounded-lg border border-border bg-card pl-9 pr-3 text-sm text-foreground shadow-xs",
                  "placeholder:text-muted-foreground/50",
                  "focus:border-clay/40 focus:outline-none focus:ring-4 focus:ring-clay/10"
                )}
              />
            </div>
            <Button
              type="submit"
              variant="outline"
              size="sm"
              className="h-9 border-border bg-card text-[13px] shadow-xs hover:bg-secondary"
            >
              Search
            </Button>
          </form>
        </div>
      </section>

      {/* ————— Discovery strip (spec §11) ————— */}
      {discovery && !isSearching && (discovery.people.length > 0 || discovery.topics.length > 0) && (
        <div className="space-y-1.5">
          {discovery.people.length > 0 && (
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              People you mention{" "}
              {discovery.people.map((person, index) => (
                <span key={person.id}>
                  {index > 0 && <span className="text-muted-foreground/50"> · </span>}
                  <Link
                    href={entityHrefFromParts(person.id, "person")}
                    className="text-foreground underline decoration-border underline-offset-4 transition-colors duration-200 hover:decoration-clay"
                  >
                    {person.name}
                  </Link>
                  <span className="ml-1 font-mono text-[10px] tracking-[0.1em] text-muted-foreground/60">
                    {person.memoryCount}
                  </span>
                </span>
              ))}
            </p>
          )}
          {discovery.topics.length > 0 && (
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              Topics you&apos;ve written about{" "}
              {discovery.topics.map((topic, index) => (
                <span key={topic.id}>
                  {index > 0 && <span className="text-muted-foreground/50"> · </span>}
                  <Link
                    href={entityHrefFromParts(topic.id, "topic")}
                    className="text-foreground underline decoration-border underline-offset-4 transition-colors duration-200 hover:decoration-clay"
                  >
                    {topic.name}
                  </Link>
                  <span className="ml-1 font-mono text-[10px] tracking-[0.1em] text-muted-foreground/60">
                    {topic.memoryCount}
                  </span>
                </span>
              ))}
            </p>
          )}
        </div>
      )}

      <section className="border-t border-border/60 pb-24 pt-10">
        {result.items.length > 0 ? (
          <>
            <div className="divide-y divide-border/60">
              {result.items.map((memory) => (
                <MemoryEntry key={memory.id} memory={memory} />
              ))}
            </div>

            {totalPages > 1 && (
              <nav
                aria-label="Pagination"
                className="mt-10 flex items-center justify-between font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground"
              >
                {page > 1 ? (
                  <Link
                    href={pageHref(q, page - 1)}
                    className="transition-colors hover:text-foreground"
                  >
                    ← Newer
                  </Link>
                ) : (
                  <span className="opacity-40">← Newer</span>
                )}
                <span>
                  Page {page} of {totalPages}
                </span>
                {page < totalPages ? (
                  <Link
                    href={pageHref(q, page + 1)}
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
        ) : isSearching ? (
          <EmptyState
            icon={Search}
            title={`Nothing matches “${q}”.`}
            description="Try different words — the search looks at titles and the words you wrote."
          />
        ) : (
          <EmptyState
            icon={Bookmark}
            title="Your archive begins with the first thing you keep."
            description="Write something on the home page — it will gather here, newest first."
          />
        )}
      </section>
    </div>
  );
}
