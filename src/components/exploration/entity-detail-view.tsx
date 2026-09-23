import Link from "next/link";
import { ArrowLeft, CalendarDays } from "lucide-react";
import { AskBox } from "@/components/ask/ask-box";
import { MemoryEntry } from "@/components/memory/memory-entry";
import { EntityChipLinks } from "@/components/exploration/entity-rows";
import { TimelineView } from "@/components/exploration/timeline-view";
import { MicroLabel } from "@/components/shared/micro-label";
import { entityHrefFromParts } from "@/lib/entity-links";
import { formatDate } from "@/lib/format";
import type { EntityType } from "@/types/entity";
import type { EntityDetailData } from "@/types/exploration";
import type { ResolvedRelation } from "@/types/relation";

/**
 * EntityDetailView — the shared body of the person and topic pages.
 *
 * The name, the memories that mention it, the topics/people it
 * appears alongside, its timeline, and the explicit connections the
 * graph carries. Nothing is invented: counts are database numbers,
 * dates are dates the memories carry, and the conversation at the
 * bottom runs the existing scoped chat — the same planner, the same
 * retrievers, focused on this one thing.
 */

export interface EntityDetailViewProps {
  data: EntityDetailData;
  /** Which index to link back to, and which related chips to lead with. */
  mode: "person" | "topic";
  page: number;
  connections: Array<{
    key: string;
    relationType: string;
    label: string;
    href: string | null;
  }>;
}

/**
 * Resolve each relation touching this entity into a row pointing at
 * its OTHER endpoint — a memory page, or the other entity's own page.
 * `typeById` supplies entity types so links land on the right surface.
 */
export function prepareConnections(
  entityId: string,
  typeById: Map<string, EntityType>,
  connections: ResolvedRelation[]
): Array<{ key: string; relationType: string; label: string; href: string | null }> {
  const rows: Array<{ key: string; relationType: string; label: string; href: string | null }> = [];
  for (const entry of connections) {
    const { relation } = entry;
    const otherIsTarget =
      relation.sourceType === "entity" && relation.sourceId === entityId;
    const otherType = otherIsTarget ? relation.targetType : relation.sourceType;
    const otherId = otherIsTarget ? relation.targetId : relation.sourceId;
    const otherLabel = otherIsTarget ? entry.targetLabel : entry.sourceLabel;

    // Skip self-loops and unresolvable endpoints.
    if (otherType === "entity" && otherId === entityId) continue;
    if (!otherLabel) continue;

    rows.push({
      key: `${relation.id}-${otherIsTarget ? "t" : "s"}`,
      relationType: relation.relationType,
      label: otherLabel,
      href:
        otherType === "memory"
          ? `/memories/${otherId}`
          : typeById.get(otherId)
            ? entityHrefFromParts(otherId, typeById.get(otherId)!)
            : null,
    });
  }
  return rows;
}

export function EntityDetailView({ data, mode, page, connections }: EntityDetailViewProps) {
  const backHref = mode === "person" ? "/people" : "/topics";
  const backLabel = mode === "person" ? "People" : "Topics";
  const totalPages = Math.max(1, Math.ceil(data.memories.total / data.memories.pageSize));
  const related =
    mode === "person"
      ? { label: "Topics", items: data.topics, variant: "topic" as const }
      : { label: "People", items: data.people, variant: "person" as const };
  // A topic also shows sibling topics when no people co-occur.
  const secondaryRelated =
    mode === "topic" && data.people.length === 0 && data.topics.length > 0
      ? { label: "Related topics", items: data.topics, variant: "topic" as const }
      : null;

  return (
    <div className="mx-auto w-full max-w-3xl px-6">
      {/* ————— Back ————— */}
      <div className="pb-10 pt-10 sm:pt-14">
        <Link
          href={backHref}
          className="group inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground transition-colors duration-200 hover:text-foreground"
        >
          <ArrowLeft
            aria-hidden="true"
            className="size-3 transition-transform duration-200 group-hover:-translate-x-0.5"
          />
          {backLabel}
        </Link>
      </div>

      {/* ————— The entity ————— */}
      <article className="animate-in fade-in slide-in-from-bottom-2 duration-700">
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground/70">
          {data.entity.type} · {data.memoryCount}{" "}
          {data.memoryCount === 1 ? "memory" : "memories"}
          {data.lastKeptAt && ` · last kept ${formatDate(data.lastKeptAt)}`}
        </p>
        <h1 className="mt-4 font-display text-3xl font-medium leading-tight text-foreground sm:text-4xl">
          {data.entity.name}
        </h1>
      </article>

      {/* ————— Topics / People ————— */}
      {(related.items.length > 0 || (secondaryRelated && secondaryRelated.items.length > 0)) && (
        <section className="mt-10 border-t border-border/60 pt-8">
          <EntityChipLinks
            label={related.label}
            items={related.items}
            variant={related.variant}
          />
          {secondaryRelated && secondaryRelated.items.length > 0 && (
            <div className={related.items.length > 0 ? "mt-8" : undefined}>
              <EntityChipLinks
                label={secondaryRelated.label}
                items={secondaryRelated.items}
                variant={secondaryRelated.variant}
              />
            </div>
          )}
        </section>
      )}

      {/* ————— Memories ————— */}
      <section className="mt-10 border-t border-border/60 pt-8">
        <div className="flex items-baseline justify-between gap-4">
          <MicroLabel as="h2">Memories</MicroLabel>
          {data.memories.total > 0 && (
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground/60">
              {data.memories.total} kept
            </span>
          )}
        </div>

        {data.memories.items.length > 0 ? (
          <>
            <div className="mt-2 divide-y divide-border/60">
              {data.memories.items.map((memory) => (
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
                    href={`/${mode === "person" ? "people" : "topics"}/${data.entity.id}?page=${page - 1}`}
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
                    href={`/${mode === "person" ? "people" : "topics"}/${data.entity.id}?page=${page + 1}`}
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
        ) : (
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            No active memories involve this right now.
          </p>
        )}
      </section>

      {/* ————— Timeline ————— */}
      <section className="mt-10 border-t border-border/60 pt-8">
        <div className="flex items-baseline justify-between gap-4">
          <MicroLabel as="h2">Timeline</MicroLabel>
          <Link
            href={`/timeline?entity=${data.entity.id}`}
            className="group inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground transition-colors duration-200 hover:text-foreground"
          >
            <CalendarDays aria-hidden="true" className="size-3" />
            View in timeline
          </Link>
        </div>
        {data.timeline.length > 0 ? (
          <div className="mt-6">
            <TimelineView years={data.timeline} />
            {data.timelineTruncated && (
              <p className="mt-6 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground/50">
                Showing the most recent dated memories — everything lives in the list above.
              </p>
            )}
          </div>
        ) : (
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            None of these memories carry a known date, so there&apos;s nothing to place on a
            timeline yet.
          </p>
        )}
      </section>

      {/* ————— Connections ————— */}
      {connections.length > 0 && (
        <section className="mt-10 border-t border-border/60 pt-8">
          <MicroLabel as="h2">Connections</MicroLabel>
          <ul className="mt-3 space-y-2.5">
            {connections.map((connection) => (
              <li key={connection.key} className="flex items-baseline gap-3">
                <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground/60">
                  {connection.relationType.replace(/_/g, " ")}
                </span>
                {connection.href ? (
                  <Link
                    href={connection.href}
                    className="text-sm text-foreground underline decoration-border underline-offset-4 transition-colors duration-200 hover:decoration-clay"
                  >
                    {connection.label}
                  </Link>
                ) : (
                  <span className="text-sm text-foreground">{connection.label}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ————— Scoped chat (spec §3/§5) ————— */}
      <section className="mt-14 border-t border-border/60 pb-24 pt-8">
        <MicroLabel as="h2">
          Talk about {data.entity.name}
        </MicroLabel>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">
          {mode === "person"
            ? "“What did we decide together?” “فاكر إمتى اتنقابلنا؟” — the conversation stays focused on this person and everything kept around them."
            : "“Where did this leave off?” “إيه اللي حصل في المشروع ده؟” — the conversation stays focused on this topic and everything kept around it."}
        </p>
        <div className="mt-6">
          <AskBox
            scope="entity"
            scopeId={data.entity.id}
            placeholder={`Ask about ${data.entity.name}…`}
          />
        </div>
      </section>
    </div>
  );
}
