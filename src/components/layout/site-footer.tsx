import { Wordmark } from "@/components/brand/wordmark";
import { NavLink } from "@/components/layout/nav-link";
import { secondaryNav } from "@/config/app";
import { appConfig } from "@/config/app";

/**
 * The footer — quiet closure. Sticks to the bottom of the viewport when
 * the page is short, and is pushed down naturally when it is not.
 */
export function SiteFooter() {
  return (
    <footer className="mt-auto border-t border-border/70">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-10 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1.5">
          <Wordmark className="text-base" />
          <p className="max-w-60 text-sm leading-relaxed text-muted-foreground">
            {appConfig.tagline}
          </p>
        </div>

        <nav aria-label="Secondary" className="flex flex-wrap items-center gap-x-5 gap-y-2">
          {secondaryNav.map((item) => (
            <NavLink key={item.href} item={item} className="text-[13px]" />
          ))}
        </nav>
      </div>

      <div className="mx-auto w-full max-w-3xl px-6 pb-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground/60">
            A personal memory space
          </p>
          <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground/60">
            <a href="/privacy" className="transition-colors hover:text-foreground">
              Privacy
            </a>
          </p>
        </div>
      </div>
    </footer>
  );
}
