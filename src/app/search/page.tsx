import Link from "next/link";
import { Search, SearchX } from "lucide-react";
import { MemoryEntry } from "@/components/memory/memory-entry";
import { AskBox } from "@/components/ask/ask-box";
import { EmptyState } from "@/components/shared/empty-state";
import { MicroLabel } from "@/components/shared/micro-label";
import { Button } from "@/components/ui/button";
import { requirePageUser } from "@/modules/user";
import { getMemoriesByIds } from "@/modules/memory";
import { getEntity, getEntityMemories } from "@/modules/entity";
import { searchMemorySpace } from "@/modules/query";
import { entityHrefFromParts } from "@/lib/entity-links";
import { formatDate, snippet } from "@/lib/format";
import type { MemoryListItem } from "@/types/memory";
import { cn } from "@/lib/utils";

/**
 * Search — find anything you've kept, the honest way.
 *
 * This page runs the deterministic retrieval engine (no AI call, no
 * pretense): your words, your people & things, and the times you
 * name. Results group into memories, entities, and topics. Semantic
 * search is honestly deferred, and nothing here pretends otherwise.
 */

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const userId = (await requirePageUser()).id;

  const q = typeof params.q === "string" ? params.q.trim() : "";
  const entityScopeId = typeof params.entity === "string" ? params.entity : null;

  const result = userId && q !== "" ? await searchMemorySpace(userId, q) : null;

  // Entity scope: /search?entity=<id> shows one saved thing's memories.
  const entityScope =
    userId && entityScopeId ? await loadEntityScope(userId, entityScopeId) : null;

  const hasQuery = q !== "" || entityScope !== null;
  const heading = entityScope
    ? entityScope.entityName
    : result
      ? `${result.memories.length} ${result.memories.length === 1 ? "memory" : "memories"} found`
      : "Find anything you've kept.";

  return (
    <div className="mx-auto w-full max-w-3xl px-6">
      <section className="pb-10 pt-14 sm:pt-16">
        <MicroLabel as="h1">Search</MicroLabel>
        <p className="mt-3 font-display text-2xl font-medium text-foreground">{heading}</p>
        {entityScope ? (
          <p className="mt-2 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground/60">
            Everything kept involving this {entityScope.entityType}
          </p>
        ) : (
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">
            Your words, the people and things you&apos;ve saved, and the times you name — searched
            together. No pretending: it looks at what you actually wrote.
          </p>
        )}

        <form action="/search" method="GET" className="mt-6 flex w-full items-center gap-2">
          <label htmlFor="search-query" className="sr-only">
            Search your memories
          </label>
          <div className="relative flex-1">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/50"
            />
            <input
              id="search-query"
              name="q"
              type="search"
              defaultValue={q}
              placeholder="Search, or ask in your own words…"
              className={cn(
                "h-10 w-full rounded-lg border border-border bg-card pl-9 pr-3 text-sm text-foreground shadow-xs",
                "placeholder:text-muted-foreground/50",
                "focus:border-clay/40 focus:outline-none focus:ring-4 focus:ring-clay/10"
              )}
            />
          </div>
          <Button
            type="submit"
            variant="outline"
            size="sm"
            className="h-10 border-border bg-card text-[13px] shadow-xs hover:bg-secondary"
          >
            Search
          </Button>
        </form>
      </section>

      <section className="border-t border-border/60 pb-24 pt-10">
        {!hasQuery ? (
          <EmptyState
            icon={Search}
            title="Search the way you'd say it."
            description="A name, a place, a month — “أغسطس”, “Ahmed”, “the website project”. Kept looks through your words, your saved people & things, and time windows together."
          />
        ) : entityScope ? (
          entityScope.memories.length > 0 ? (
            <div className="divide-y divide-border/60">
              {entityScope.memories.map((memory) => (
                <MemoryEntry key={memory.id} memory={memory} />
              ))}
            </div>
          ) : (
            <EmptyState
              icon={SearchX}
              title="Nothing kept about this yet."
              description="When a memory involves this, it will appear here."
            />
          )
        ) : result ? (
          <>
            {result.time.from && result.time.to ? (
              <p className="mb-8 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground/60">
                Time searched: {formatDate(new Date(result.time.from))} –{" "}
                {formatDate(new Date(result.time.to))}
                {result.time.uncertain ? " (approximate)" : ""}
              </p>
            ) : null}

            {result.memories.length > 0 ? (
              <div className="divide-y divide-border/60">
                {result.memories.map((memory) => (
                  <article key={memory.memoryId} className="py-5 first:pt-0">
                    <Link href={`/memories/${memory.memoryId}`} className="group block">
                      <div className="flex items-baseline justify-between gap-4">
                        <h3 className="font-display text-lg font-medium leading-snug text-foreground transition-colors duration-200 group-hover:text-clay">
                          {memory.title ?? "Untitled"}
                        </h3>
                        <time
                          dateTime={memory.createdAt}
                          className="shrink-0 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground/60"
                        >
                          {formatDate(new Date(memory.createdAt))}
                        </time>
                      </div>
                      <p className="mt-1.5 line-clamp-2 text-sm leading-relaxed text-muted-foreground">
                        {memory.snippet}
                      </p>
                      <p className="mt-2.5 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground/50">
                        {memory.memoryType} · {memory.reason}
                      </p>
                    </Link>
                  </article>
                ))}
              </div>
            ) : (
              <EmptyState
                icon={SearchX}
                title={`Nothing matches “${result.query}” yet.`}
                description="Try a name Kept might know, different words, or a time like “last month”. What you keep is what Kept can find."
              />
            )}

            {(result.entities.length > 0 || result.topics.length > 0) && (
              <div className="mt-12 border-t border-border/60 pt-8">
                <MicroLabel as="h2">People &amp; things in play</MicroLabel>
                <div className="mt-4 flex flex-wrap gap-2">
                  {result.entities.map((entity) => (
                    <Link
                      key={entity.entityId}
                      href={entityHrefFromParts(entity.entityId, entity.type)}
                      className={cn(
                        "rounded-full border border-border bg-card px-3 py-1.5 text-[13px] text-foreground shadow-xs",
                        "transition-colors hover:border-clay/40 hover:text-clay"
                      )}
                    >
                      {entity.name}
                      <span className="ml-2 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground/60">
                        {entity.type}
                      </span>
                    </Link>
                  ))}
                  {result.topics.map((topic) => (
                    <Link
                      key={topic.entityId}
                      href={`/topics/${topic.entityId}`}
                      className={cn(
                        "rounded-full border border-clay/30 bg-clay/5 px-3 py-1.5 text-[13px] text-foreground shadow-xs",
                        "transition-colors hover:border-clay/60 hover:text-clay"
                      )}
                    >
                      {topic.name}
                      <span className="ml-2 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground/60">
                        topic
                      </span>
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : null}

        {/* Entity-scoped chat (spec §11): ask about this thing, in place. */}
        {entityScope && (
          <section className="mt-14 border-t border-border/60 pt-8">
            <MicroLabel as="h2">Chat about {entityScope.entityName}</MicroLabel>
            <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">
              Ask about this {entityScope.entityType} and everything kept around it —
              the conversation stays focused here.
            </p>
            <div className="mt-6">
              <AskBox
                scope="entity"
                scopeId={entityScopeId}
                placeholder={`Ask about ${entityScope.entityName}…`}
              />
            </div>
          </section>
        )}
      </section>
    </div>
  );
}

/** Entity-scoped results: everything kept involving one saved thing. */
async function loadEntityScope(userId: string, entityId: string) {
  const entity = await getEntity(userId, entityId).catch(() => null);
  if (!entity) return null;

  const links = await getEntityMemories(userId, entityId);
  const rows = await getMemoriesByIds(
    userId,
    links.map((link) => link.memoryId)
  );

  const memories: MemoryListItem[] = rows
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .map((memory) => ({
      id: memory.id,
      title: memory.title,
      snippet: snippet(memory.originalContent),
      memoryType: memory.memoryType,
      status: memory.status,
      processingStatus: memory.processingStatus,
      rememberedAt: memory.rememberedAt,
      createdAt: memory.createdAt,
    }));

  return { entityName: entity.name, entityType: entity.type, memories };
}
