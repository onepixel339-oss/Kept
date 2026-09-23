import { MemoryItemSkeleton } from "@/components/shared/loading";

/**
 * Memory detail loading state — the shape of a memory, still arriving.
 */
export default function MemoryDetailLoading() {
  return (
    <div className="mx-auto w-full max-w-3xl animate-pulse px-6">
      <div className="flex items-center justify-between pb-10 pt-10 sm:pt-14">
        <div className="h-3 w-24 rounded bg-muted" />
        <div className="h-8 w-32 rounded bg-muted" />
      </div>
      <div className="space-y-4 pt-2">
        <div className="h-3 w-40 rounded bg-muted" />
        <div className="h-10 w-3/4 rounded bg-muted" />
        <div className="space-y-3 pt-6">
          <div className="h-4 w-full rounded bg-muted" />
          <div className="h-4 w-11/12 rounded bg-muted" />
          <div className="h-4 w-4/5 rounded bg-muted" />
        </div>
      </div>
      <div className="mt-16 hidden">
        <MemoryItemSkeleton />
      </div>
    </div>
  );
}
