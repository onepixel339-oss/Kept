"use client";

import { Wordmark } from "@/components/brand/wordmark";
import { NavLink } from "@/components/layout/nav-link";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { SignOutButton } from "@/components/settings/account-controls";
import { primaryNav, secondaryNav } from "@/config/app";

/**
 * The masthead — a two-tier editorial header, like the opening of a
 * well-made journal. Row one: identity. Row two: a thin index of the
 * product's areas. No sidebar, no hamburger, no noise.
 *
 * Signed in: the account's email sits quietly at the right of row one
 * with sign-out beside it. Signed out: just the theme toggle.
 */
export function SiteHeader({
  userEmail,
}: {
  userEmail?: string | null;
}) {
  return (
    <header className="sticky top-0 z-40 border-b border-border/70 bg-background/85 backdrop-blur-sm">
      <div className="mx-auto w-full max-w-3xl px-6">
        {/* Row one — identity */}
        <div className="flex h-14 items-center justify-between">
          <Wordmark />
          <div className="flex items-center gap-3">
            {userEmail && (
              <>
                <span
                  className="hidden max-w-44 truncate font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground sm:inline"
                  title={userEmail}
                >
                  {userEmail}
                </span>
                <SignOutButton />
              </>
            )}
            <ThemeToggle />
          </div>
        </div>
      </div>

      {/* Row two — the index */}
      <nav aria-label="Primary" className="border-t border-border/60">
        <div className="mx-auto flex h-10 w-full max-w-3xl items-center justify-between px-6">
          <div className="flex items-center gap-6">
            {primaryNav.map((item) => (
              <NavLink key={item.href} item={item} />
            ))}
          </div>
          <div className="hidden items-center gap-5 sm:flex">
            {secondaryNav.map((item) => (
              <NavLink
                key={item.href}
                item={item}
                className="text-[13px] tracking-wide"
              />
            ))}
          </div>
        </div>
      </nav>
    </header>
  );
}
