import { MemoryListSkeleton } from "@/components/shared/loading";
import { MicroLabel } from "@/components/shared/micro-label";

/**
 * Memories loading state — skeletons shaped like the list they become.
 */
export default function MemoriesLoading() {
  return (
    <div className="mx-auto w-full max-w-3xl px-6">
      <section className="pb-10 pt-14 sm:pt-16">
        <MicroLabel as="h1">Memories</MicroLabel>
      </section>
      <section className="border-t border-border/60 pb-24 pt-10">
        <MemoryListSkeleton count={4} />
      </section>
    </div>
  );
}
