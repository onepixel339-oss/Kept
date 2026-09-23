import Link from "next/link";
import { cn } from "@/lib/utils";
import { appConfig } from "@/config/app";

/**
 * The wordmark — the product's name set in its own voice.
 * Quiet, typographic, with the clay full stop as the single flourish.
 */
export function Wordmark({ className }: { className?: string }) {
  return (
    <Link
      href="/"
      aria-label={`${appConfig.name} — home`}
      className={cn(
        "inline-flex items-baseline font-display text-xl font-medium tracking-tight text-foreground",
        "transition-opacity duration-200 hover:opacity-80",
        className
      )}
    >
      {appConfig.name}
      <span aria-hidden="true" className="text-clay">
        .
      </span>
    </Link>
  );
}
