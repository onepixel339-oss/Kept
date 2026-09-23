"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import type { NavItem } from "@/config/app";

/**
 * A navigation link that tells the truth.
 *
 * Enabled items navigate. Disabled items (areas arriving in a later
 * phase) render muted and non-interactive — the shell shows the
 * product's shape without pretending features exist.
 */
export function NavLink({ item, className }: { item: NavItem; className?: string }) {
  const pathname = usePathname();
  const isActive = item.enabled && pathname === item.href;

  if (!item.enabled) {
    return (
      <span
        aria-disabled="true"
        title={item.hint}
        className={cn(
          "cursor-not-allowed select-none text-sm text-muted-foreground/45",
          className
        )}
      >
        {item.label}
      </span>
    );
  }

  return (
    <Link
      href={item.href}
      aria-current={isActive ? "page" : undefined}
      className={cn(
        "relative text-sm transition-colors duration-200",
        "hover:text-foreground",
        isActive ? "text-foreground" : "text-muted-foreground",
        className
      )}
    >
      {item.label}
      {isActive && (
        <span
          aria-hidden="true"
          className="absolute -bottom-[3px] left-0 right-0 h-px bg-clay"
        />
      )}
    </Link>
  );
}
