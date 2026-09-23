import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { MemoryVersion } from "@/types/memory-version";

/**
 * VersionHistory — the memory's past, readable in place.
 *
 * Native details/summary keeps it calm and dependency-free: each
 * version opens on demand, and the current state always remains one
 * glance away.
 */
export function VersionHistory({ versions }: { versions: MemoryVersion[] }) {
  if (versions.length === 0) return null;

  // Newest first in display; the current state is the memory itself.
  const history = [...versions].reverse();

  return (
    <div className="divide-y divide-border/60">
      {history.map((version) => (
        <details key={version.id} className="group py-4 first:pt-0">
          <summary
            className={cn(
              "flex w-full cursor-pointer list-none items-center gap-3 text-left",
              "transition-colors duration-150 hover:[&>span:nth-child(2)]:text-clay",
              "[&::-webkit-details-marker]:hidden"
            )}
            aria-label={`Version ${version.versionNumber}, ${version.changeType}`}
          >
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              v{version.versionNumber}
            </span>
            <span className="text-sm text-foreground">
              {version.changeType === "created" ? "First kept" : "Edited"}
            </span>
            {version.changeReason && (
              <span className="hidden text-xs text-muted-foreground/70 sm:inline">
                — {version.changeReason}
              </span>
            )}
            <time
              dateTime={version.createdAt.toISOString()}
              className="ml-auto font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground/60"
            >
              {formatDate(version.createdAt)}
            </time>
          </summary>
          <div className="mt-3 max-h-64 overflow-y-auto rounded-lg border border-border/70 bg-muted/40 px-4 py-3">
            {version.title && (
              <p className="font-display text-sm font-medium text-foreground">{version.title}</p>
            )}
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
              {version.originalContent}
            </p>
            {version.summary && (
              <p className="mt-2 border-t border-border/60 pt-2 text-xs italic leading-relaxed text-muted-foreground/80">
                Summary then: {version.summary}
              </p>
            )}
          </div>
        </details>
      ))}
    </div>
  );
}
