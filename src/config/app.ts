/**
 * Application configuration — the quiet facts about this product.
 *
 * Product-facing copy (name, tagline, descriptions) lives here so the
 * interface stays consistent and renames are a one-file change.
 */

export const appConfig = {
  /** Working product identity. Deliberately warm, personal, and short. */
  name: "Kept",
  tagline: "A quiet place to keep what matters.",
  description:
    "A personal memory space. Write things down in your own words — Kept understands, organizes, and connects them, so you can find them again the moment you need them.",
  /** The primary question the home page asks. The product's signature line. */
  memoryPrompt: "What would you like to remember?",
} as const;

export type AppMetadata = typeof appConfig;

/**
 * Navigation model.
 *
 * `enabled: false` marks areas whose routes do not exist yet. Disabled
 * items render honestly (muted, non-interactive) — the shell shows the
 * product's shape without pretending features exist.
 */
export interface NavItem {
  label: string;
  href: string;
  enabled: boolean;
  /** Optional context for screen readers and tooltips. */
  hint?: string;
}

/** Primary navigation — always visible, never dominating. */
export const primaryNav: NavItem[] = [
  { label: "Home", href: "/", enabled: true },
  { label: "Memories", href: "/memories", enabled: true },
  { label: "Search", href: "/search", enabled: true },
  { label: "Ask", href: "/ask", enabled: true },
];

/** Secondary navigation — accessible without dominating the interface. */
export const secondaryNav: NavItem[] = [
  { label: "People", href: "/people", enabled: true },
  { label: "Topics", href: "/topics", enabled: true },
  { label: "Timeline", href: "/timeline", enabled: true },
  { label: "Settings", href: "/settings", enabled: true, hint: "Account, security, privacy, data" },
];
