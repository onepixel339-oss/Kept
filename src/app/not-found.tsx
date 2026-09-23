import Link from "next/link";
import { appConfig } from "@/config/app";

/**
 * Not found — a quiet dead end with a door back.
 */
export default function NotFound() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col items-center px-6 py-28 text-center sm:py-36">
      <p className="font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
        Nothing here
      </p>
      <h1 className="mt-5 max-w-md font-display text-3xl font-medium leading-tight text-foreground sm:text-4xl">
        This page has no memory of existing.
      </h1>
      <p className="mt-4 max-w-sm text-[15px] leading-relaxed text-muted-foreground">
        The address doesn&apos;t match anything in {appConfig.name}. The way
        back is one step away.
      </p>
      <Link
        href="/"
        className="mt-8 inline-flex h-10 items-center rounded-lg border border-border bg-card px-5 text-sm font-medium text-foreground shadow-xs transition-colors duration-200 hover:bg-secondary focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-clay/15"
      >
        Return home
      </Link>
    </div>
  );
}
