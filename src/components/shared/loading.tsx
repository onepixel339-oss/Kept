import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * Loading states — skeletons shaped like what they will become.
 *
 * A memory list never resolves into a spinner; it resolves into
 * memories. The skeletons mirror that final geometry so the page
 * settles instead of jumping.
 */

/** One memory, still arriving. */
export function MemoryItemSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn("space-y-3 py-5", className)}>
      <div className="flex items-center justify-between gap-4">
        <Skeleton className="h-4 w-2/5" />
        <Skeleton className="h-3 w-16" />
      </div>
      <Skeleton className="h-3 w-full max-w-xl" />
      <Skeleton className="h-3 w-3/4 max-w-md" />
    </div>
  );
}

/** A list of memories, still arriving. */
export function MemoryListSkeleton({
  count = 3,
  className,
}: {
  count?: number;
  className?: string;
}) {
  return (
    <div className={cn("divide-y divide-border/60", className)}>
      {Array.from({ length: count }).map((_, i) => (
        <MemoryItemSkeleton key={i} />
      ))}
    </div>
  );
}
