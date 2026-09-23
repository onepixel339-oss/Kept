import { MemoryListSkeleton } from "@/components/shared/loading";

/** Quiet skeleton shaped like the People index it becomes. */
export default function PeopleLoading() {
  return (
    <div className="mx-auto w-full max-w-3xl px-6">
      <section className="pb-10 pt-14 sm:pt-16">
        <p className="font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
          People
        </p>
      </section>
      <section className="border-t border-border/60 pb-24 pt-10">
        <MemoryListSkeleton count={5} />
      </section>
    </div>
  );
}
