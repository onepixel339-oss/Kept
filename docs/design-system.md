# Kept — Design System

The visual identity of Kept: **warm, editorial, personal, calm**. The
product should feel like a beautifully made journal or personal archive —
never like an AI tool, never like a dashboard.

## 1. Direction

### We are

- Calm and spacious — generous whitespace, few elements, clear hierarchy
- Editorial — typography leads; a display serif speaks, a sans works, a
  mono annotates
- Warm — every color carries a whisper of warmth; nothing is cold
- Personal — the tone is that of a well-kept journal, not an app
- Restrained — one accent color, hairline borders, quiet shadows

### We never are

- Futuristic/AI-styled: no glowing gradients, no purple/blue tech
  aesthetics, no robot imagery, no "AI Assistant" branding
- Dashboard-heavy: no stat cards, no metrics, no widget grids
- Default-shadcn: shadcn/ui is the component foundation, customized
  through tokens and composition so the result looks like Kept, not like
  a template
- Noisy: no motion for decoration's sake; animations are subtle, short,
  and purposeful (and disabled under `prefers-reduced-motion`)

## 2. Color tokens

Defined once in `src/app/globals.css` as OKLCH CSS variables, mapped into
Tailwind via `@theme inline`. Light theme is the identity; dark theme
("lamplight") is designed with equal care.

| Token | Light (warm daylight) | Dark (lamplight) | Role |
|-------|----------------------|------------------|------|
| `background` | Warm paper `oklch(0.982 0.0045 85)` | Warm charcoal `oklch(0.19 0.007 70)` | Page ground |
| `foreground` | Warm ink `oklch(0.26 0.013 70)` | Warm off-white | Primary text |
| `card` | Brighter paper | Slightly lifted charcoal | Input wells, raised surfaces |
| `muted` / `muted-foreground` | Warm gray / warm gray text | Warm dark gray / softer text | Secondary text, quiet fills |
| `secondary` | Warm light gray | Warm mid charcoal | Buttons, subtle surfaces |
| `accent` | Soft clay tint | Dark clay glow | Hover states |
| `primary` | Warm ink | Warm off-white | Primary buttons — ink, not clay |
| `border` / `input` | Warm hairline | Translucent warm white | 1px structure everywhere |
| `destructive` | Muted warm red | Lifted warm red | Errors only |
| `ring` | Clay | Clay | Focus rings |
| `clay` | `oklch(0.58 0.11 45)` | `oklch(0.7 0.1 48)` | **The** accent |
| `clay-strong` | Deeper clay | Brighter clay | Hover/active accent |
| `clay-soft` | Pale clay wash | Dark clay wash | Selection, honest notes |

**Clay discipline:** clay is an accent — one italic word in a heading, a
focus ring, an active-nav underline, a note's left border. It is never a
large surface, never a background behind body text, never used twice in
the same visual cluster. If a screen seems to need more clay, the layout
is wrong, not the palette.

**Warmth law:** every color carries chroma near hue 60–90. Pure grays
(`oklch(x 0 0)`) and blue/indigo hues are forbidden.

## 3. Typography

Three voices, loaded in `src/app/layout.tsx` via `next/font`:

| Voice | Face | Utility | Used for |
|-------|------|---------|----------|
| Speaks | **Fraunces** (serif, normal + italic) | `font-display` | `h1–h4`, wordmark, empty-state titles, moments of voice |
| Works | **Inter** | `font-sans` (body default) | Body text, interface labels, buttons |
| Annotates | **Geist Mono** | `font-mono` | Micro-labels, metadata, hints, timestamps |

Scale (Tailwind steps):

- Display heading: `text-4xl` → `sm:text-[2.75rem]`, `font-medium`,
  `leading-[1.12]`, tracking tightened by the `h1–h4` base rule
- Section headings / empty-state titles: `text-xl font-display`
- Body: `text-[15px]` → `text-base`, `leading-relaxed`
- Secondary text: `text-sm`
- Micro-labels: `font-mono text-[11px] uppercase tracking-[0.16em]`
  (`text-muted-foreground`) — use the `MicroLabel` component

Rules: headings tighten letter-spacing (`-0.015em`); body text never
justifies; sentence case everywhere — no ALL CAPS except micro-labels;
italic + clay is reserved for single emphasized words.

## 4. Space, radius, elevation

- **Measure:** content lives in a centered `max-w-3xl` column (`px-6`).
  Header, main, and footer share this measure so edges align.
- **Spacing scale:** Tailwind's default 4px scale. Vertical rhythm on
  home: hero `pt-16/24`, sections separated by hairlines with `pt-12` /
  `pb-20+`.
- **Radius:** `--radius: 0.625rem` (10px), with Tailwind's derived
  `sm/md/lg/xl`. Inputs and buttons `rounded-lg/xl`; nothing pill-shaped
  by default.
- **Shadows:** warm-tinted (`oklch(0.3 0.02 70 / …)`), defined as
  `shadow-xs/sm/md/lg` tokens. Shadows are felt, not seen; elevation is
  rare — hairlines do most structural work.
- **Borders:** hairlines at 60–70% opacity of `border` separate
  sections; full-strength borders only on interactive wells.
- **Paper grain:** a fixed, near-invisible noise overlay
  (`body::after`, opacity 0.022) adds material warmth. Never remove it
  casually; never raise it above ~0.03.

## 5. Structure and motion

- **Masthead:** two-tier editorial header — identity row (wordmark +
  theme toggle), then a thin index row (primary nav left, secondary
  right, secondary hidden on mobile). Sticky, blurred, hairline-bounded.
  No sidebar exists in this product.
- **Navigation honesty:** areas whose routes do not exist render muted,
  non-interactive, with `aria-disabled` and a title hint — the shell
  shows the product's shape without pretending.
- **Footer:** quiet closure on a hairline; sticks to viewport bottom via
  the `min-h-svh flex flex-col` + `flex-1 main` pattern.
- **Motion:** entrance fades (`animate-in fade-in slide-in-from-bottom-2
  duration-700`, staggered ~150ms), focus-ring blooms
  (`ring-clay/10`), button reveals (`opacity`/`translate` ~300ms). If a
  motion cannot be described in one calm sentence, it does not ship.

## 6. States

- **Empty:** `EmptyState` — icon in muted clay, a Fraunces line, a short
  forward-looking sentence. Never an apology, never an illustration dump.
- **Loading:** skeletons shaped like the content that will replace them
  (`MemoryItemSkeleton`, `MemoryListSkeleton`) — never a bare spinner.
- **Error:** `ErrorState` — calm, specific, blame-free, always with a
  way forward (`Try again`). Global failures use `app/error.tsx`.
- **Honest pending:** features not yet wired respond truthfully (see the
  memory input's note) — never fake success.

## 6b. Memory surfaces (Phase 2)

- **Lists** (`MemoryEntry`, home + Memories page): title in Fraunces,
  two-line muted excerpt (`line-clamp-2`), date in tiny mono at the
  baseline right, type as a mono whisper below. Rows separated by
  hairlines (`divide-y`) — no cards. Hover moves the title to clay.
- **Detail:** mono meta line (type · remembered · kept · status) above a
  Fraunces headline; the original content is the visual center in
  `text-[16px]/[17px] leading-[1.8]`, verbatim with `whitespace-pre-wrap`.
  A user-written summary, when present, hangs off a clay left border.
  Entities render as one inline "People & things" line; related memories
  are a quiet underlined-link list prefixed by their relation type.
- **Editing:** an inline card on the detail page (`bg-card`, hairline
  border, soft shadow) — inputs stay quiet, labels are micro-labels.
- **History:** native `details/summary` rows — `v2 · Edited · date` —
  expanding to the past state on a muted panel. No modals for reading
  the past.
- **Honesty in copy:** saved means "Saved." — nothing claims
  understanding. Search says it searches "titles and the words you
  wrote." Deletion names exactly what goes and what stays.

## 7. Components

- **Foundation:** shadcn/ui primitives in `src/components/ui` (New York
  style). Customize at usage with tokens and classes; do not restyle the
  primitives themselves without intent, and do not add a second UI
  library.
- **Kept components:** `Wordmark`, `NavLink`, `SiteHeader`, `SiteFooter`,
  `ThemeToggle`, `MemoryInput`, `MicroLabel`, `EmptyState`, `ErrorState`,
  `MemoryListSkeleton` — each small, named for its role, documented in
  its header comment.

## 8. Iconography and imagery

- **Icons:** Lucide only, `size-4` inline / `size-8` empty-state, weight
  1.5–2. Icons annotate; they never decorate.
- **Imagery:** none currently. If imagery arrives it must be
  photographic, warm, and personal — never tech-abstract, never neon.

## 9. Accessibility

- Semantic landmarks (`header`, `nav`, `main`, `footer`) with labels
- Every icon-only control has an `aria-label`; the memory input has a
  visible-text `sr-only` label pair
- Focus is always visible (`ring` tokens) and keyboard paths are real:
  Enter keeps, Shift+Enter breaks lines, buttons are ≥36px targets
- `role="status"` / `role="alert"` on dynamic notes and errors
- Reduced-motion users get a still, fully functional product
- Dark and light themes both meet the warmth law without sacrificing
  contrast
