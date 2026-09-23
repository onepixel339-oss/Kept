import { MemoryListSkeleton } from "@/components/shared/loading";

/** Quiet skeleton shaped like the detail page it becomes. */
export default function EntityDetailLoading() {
  return (
    <div className="mx-auto w-full max-w-3xl px-6">
      <section className="pb-10 pt-10 sm:pt-14">
        <p className="font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
          ← Back
        </p>
      </section>
      <MemoryListSkeleton count={4} />
    </div>
  );
}
