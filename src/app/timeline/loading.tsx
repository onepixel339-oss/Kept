import { MemoryListSkeleton } from "@/components/shared/loading";

/** Quiet skeleton shaped like the Timeline it becomes. */
export default function TimelineLoading() {
  return (
    <div className="mx-auto w-full max-w-3xl px-6">
      <section className="pb-10 pt-14 sm:pt-16">
        <p className="font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
          Timeline
        </p>
      </section>
      <section className="border-t border-border/60 pb-24 pt-10">
        <MemoryListSkeleton count={5} />
      </section>
    </div>
  );
}
