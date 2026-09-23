"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";

/**
 * Theme toggle — a small, calm control. No dropdowns, no menus.
 * Light is the identity; dark is a courtesy.
 *
 * The icons switch via the `dark:` variant alone — no mounted state,
 * no hydration mismatch, no flash. The click handler reads the theme
 * only after hydration, by definition.
 */
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();

  function toggle() {
    setTheme(resolvedTheme === "dark" ? "light" : "dark");
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={toggle}
      aria-label="Toggle theme"
      className="size-8 text-muted-foreground hover:text-foreground"
    >
      <Sun aria-hidden="true" className="hidden size-4 dark:block" />
      <Moon aria-hidden="true" className="block size-4 dark:hidden" />
    </Button>
  );
}
