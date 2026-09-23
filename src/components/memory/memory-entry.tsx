import Link from "next/link";
import { formatDate } from "@/lib/format";
import { ProcessingState } from "@/components/memory/processing-state";
import type { MemoryListItem } from "@/types/memory";

/**
 * MemoryEntry — one memory in an editorial list.
 *
 * A title that speaks, a quiet excerpt, and a whisper of metadata.
 * No cards, no thumbnails, no chrome — just typography on a hairline.
 * Processing appears only as a tiny mono whisper, and only while it
 * is not done.
 */
export function MemoryEntry({ memory }: { memory: MemoryListItem }) {
  return (
    <article className="py-5 first:pt-0">
      <Link href={`/memories/${memory.id}`} className="group block">
        <div className="flex items-baseline justify-between gap-4">
          <h3 className="font-display text-lg font-medium leading-snug text-foreground transition-colors duration-200 group-hover:text-clay">
            {memory.title ?? "Untitled"}
          </h3>
          <time
            dateTime={memory.createdAt.toISOString()}
            className="shrink-0 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground/60"
          >
            {formatDate(memory.createdAt)}
          </time>
        </div>
        <p className="mt-1.5 line-clamp-2 text-sm leading-relaxed text-muted-foreground">
          {memory.snippet}
        </p>
        <p className="mt-2.5 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground/50">
          <span>
            {memory.memoryType}
            {memory.status !== "active" && ` · ${memory.status}`}
          </span>
          <ProcessingState status={memory.processingStatus} />
        </p>
      </Link>
    </article>
  );
}
