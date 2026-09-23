import Link from "next/link";
import { formatDate } from "@/lib/format";
import { MicroLabel } from "@/components/shared/micro-label";
import type { EntitySummary } from "@/types/exploration";
import type { EntityType } from "@/types/entity";
import { entityHrefFromParts } from "@/lib/entity-links";

/**
 * EntitySummaryRow — one person or topic in an exploration index.
 *
 * A name that speaks, a whisper of quiet facts (how many memories
 * mention them, when they were last kept), and the things they
 * appear alongside. Counts are descriptive database numbers, not
 * rankings; everything shown comes from stored memory data.
 */
export function EntitySummaryRow({ summary }: { summary: EntitySummary }) {
  const { entity, memoryCount, lastKeptAt, relatedTopics, relatedPeople } = summary;

  const related =
    entity.type === "person"
      ? relatedTopics
      : relatedPeople.length > 0
        ? relatedPeople
        : relatedTopics;
  // A person row links to its topics; a topic row links to its people
  // (falling back to sibling topics when no people co-occur).
  const relatedVariant: "person" | "topic" =
    entity.type === "person" ? "topic" : relatedPeople.length > 0 ? "person" : "topic";

  return (
    <article className="py-5 first:pt-0">
      <div className="flex items-baseline justify-between gap-4">
        <h3 className="font-display text-lg font-medium leading-snug text-foreground">
          <Link
            href={entityHrefFromParts(entity.id, entity.type)}
            className="transition-colors duration-200 hover:text-clay"
          >
            {entity.name}
          </Link>
        </h3>
        <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground/60">
          {lastKeptAt ? `last kept ${formatDate(lastKeptAt)}` : "no memories kept"}
        </span>
      </div>

      <p className="mt-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground/50">
        {entity.type !== "person" && `${entity.type} · `}
        {memoryCount} {memoryCount === 1 ? "memory" : "memories"}
      </p>

      {related.length > 0 && (
        <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
          {entity.type === "person" ? "Appears with " : "Involves "}
          {related.map((item, index) => (
            <span key={item.id}>
              {index > 0 && <span className="text-muted-foreground/50"> · </span>}
              <Link
                href={entityHrefFromParts(item.id, relatedVariant)}
                className="underline decoration-border underline-offset-4 transition-colors duration-200 hover:decoration-clay"
              >
                {item.name}
              </Link>
            </span>
          ))}
        </p>
      )}
    </article>
  );
}

/**
 * EntityChipLinks — quiet inline links for related topics / people on
 * detail pages. Used under a MicroLabel heading, never as cards.
 */
export function EntityChipLinks({
  label,
  items,
  variant,
}: {
  label: string;
  items: Array<{ id: string; name: string; memoryCount: number }>;
  /** What kind of entity these links open. */
  variant: Extract<EntityType, "person" | "topic">;
}) {
  if (items.length === 0) return null;

  return (
    <div>
      <MicroLabel as="h2">{label}</MicroLabel>
      <p className="mt-3 text-sm leading-relaxed text-foreground">
        {items.map((item, index) => (
          <span key={item.id}>
            {index > 0 && <span className="text-muted-foreground/50"> · </span>}
            <Link
              href={entityHrefFromParts(item.id, variant)}
              className="underline decoration-border underline-offset-4 transition-colors duration-200 hover:decoration-clay"
            >
              {item.name}
            </Link>
            {item.memoryCount > 0 && (
              <span className="ml-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground/60">
                {item.memoryCount}
              </span>
            )}
          </span>
        ))}
      </p>
    </div>
  );
}
