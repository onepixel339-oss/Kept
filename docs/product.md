# Kept — Product

> A quiet place to keep what matters.

Kept is a personal memory space. It is not a chatbot, not an AI dashboard,
and not a notes app with an AI button. It is a place where a person stores
the things they want to remember — moments, people, places, ideas, work —
and where the system quietly understands and organizes what they put into
it, so it can be found, explored, discussed, and reasoned about later.

The defining feeling of the product is:

> "This place understands what I put into it."

Not:

> "I am using an AI tool."

## 1. What Kept is

Kept is built around a single core noun: the **memory**. A memory is one
thing the user chose to keep, stored in their own words, always preserved
exactly as written. Everything else in the product — understanding,
organization, search, conversation — exists to serve that original,
immutable content.

The intelligence of Kept is mostly invisible. When a user writes
something down, the memory is saved first — always — and then the
system quietly works behind the scenes to understand it: proposing a
title, a summary, a type, noticing the people and projects involved,
connecting related memories, and recognizing when new information
updates or contradicts what was already kept. The user never performs
"AI operations"; they simply keep things, and the space becomes
organized around them. Where the system is uncertain, it preserves the
uncertainty instead of guessing; where two things might be the same
person, it refuses to silently merge them; when processing cannot
finish, the memory stays exactly as written and says so honestly.
Intelligence in Kept assists the owner; it never replaces their
judgment and never rewrites their words.

## 2. What Kept is not

These exclusions are product decisions, not limitations, and they are
binding on every future phase:

- **Not a chatbot product.** Conversation exists only as an interaction
  layer for exploring one's own memories. There is no general-purpose
  assistant, no small talk, no "AI features" bolted onto screens.
- **Not a dashboard.** No statistics, no usage counters, no analytics
  panels, no vanity metrics. A personal archive does not grade its owner.
- **Not a social product.** Single tenant, personal, private. There are
  no feeds, no shares, no followers.
- **Not a cloud AI wrapper.** AI is a component behind a strict
  architectural boundary. The product works structurally without it, and
  every AI contribution is a validated proposal, never an autonomous act.

## 3. Product areas

| Area | Purpose | Phase |
|------|---------|-------|
| **Home** | The opening page. One question — *"What would you like to remember?"* — and the newest entries of the real archive. Beside the field, four quiet doors: an image, a voice note, a file, a link — different ways of adding a memory, not separate products. | Live (Phase 1 shell, Phase 2 wiring, Phase 3 processing, Phase 9 rich input) |
| **Memories** | The collection: browse, search by title/content, revisit. | Live (Phase 2) |
| **Memory Detail** | One memory in full: original words, gathered summary, entities, connections, processing state, version history — and, since Phase 9, "Where it came from": the original image, recording, document, or link behind it, with exactly what was read from each. | Live (Phase 2, enriched in Phase 3, Phase 9 provenance) |
| **Search** | Finding things again: your words, your people & things, and time windows searched together — honest about what it looks at (deterministic; no pretending). Scoped views grow a focused conversation ("Chat about …"). | Live (Phase 4; Phase 5 scoped chat) |
| **Ask** | Asking your memory questions in your own words — and getting grounded answers: written from the memories your question retrieved, every claim traceable ("Based on N memories"), honest when the memories don't hold something. In-chat "افتكر إني…" keeps a memory through the normal pipeline; "احذف…" runs the existing deletion flow when the target is clear. | Live (Phase 4 retrieval; Phase 5 reasoning) |
| **People** | The individuals who appear across memories — an index of who lives there, with quiet facts (how many memories, last kept, the topics they touch) and one person's full page: memories, timeline, connections, and a focused conversation. | Live (Phase 6) |
| **Topics** | The subjects and projects the archive grows around — topic/project entities with the people they involve, memories, timeline, and a focused conversation. | Live (Phase 6) |
| **Timeline** | The archive experienced as remembered time: only dates memories actually carry, grouped year by month, with an honest note about what has no date — never an invented one. Filterable by person or topic. | Live (Phase 6) |
| **Sign in / Sign up** | The door and the beginning: one email, one password, nothing else. Real accounts, real sessions — an archive belongs to someone. A calm three-step welcome (`/welcome`) opens the space after signup. | Live (Phase 7) |
| **Settings** | The account's quiet control panel: Account (email, member since, active sign-ins), Security (password change, sign out), Privacy (what is stored, in plain words), Data (export everything, explicit import of pre-account local data, delete account). | Live (Phase 7) |
| **Privacy** | `/privacy` — what Kept stores, what AI processing means here, who sees memories, how deletion and export work. Product-level honesty, not legal boilerplate. | Live (Phase 7) |

Primary navigation is deliberately small: **Home, Memories, Search, Ask**.
Everything else (People, Topics, Timeline, Settings) remains accessible
without dominating the interface. There is no giant sidebar, by design.
Signed in, the masthead shows the account's email and sign-out beside
the theme toggle — quietly, in mono.

## 4. The memory concept

A memory contains:

- **Original content** — exactly what the user wrote. Immutable in
  substance: edits create versions, and every version — including the
  first words — remains retrievable. No generated text ever replaces it.
- **Title** — a short human handle. Deterministically derived at
  creation; replaced by a better proposal only when the user had not
  chosen one themselves; always user-editable.
- **Summary** — a concise restatement. Written by the user, or gathered
  from their words by the understanding pipeline (labeled
  "Gathered from your words" when it was). Never invented beyond what
  the user wrote.
- **Memory type** — what kind of thing it is (experience, fact,
  thought, event, idea, note, conversation). Defaults to `note`;
  upgraded by validated understanding only away from the default.
- **Importance** — how significant it is (0–1). A proposal; the user has
  the final say.
- **Confidence** — how certain the system is about its understanding
  (0–1). A signal the application uses for decision gates — never a
  number displayed to the user.
- **Status** — `active`, `archived`, or `superseded`. Deletion is a
  real, confirmed removal that cleans up the graph; archiving is the
  soft path; superseded memories remain retrievable through the
  relations that replaced or merged them.
- **Processing state** — whether the system has finished understanding
  the memory (`pending`, `processing`, `ready`, `failed`). Independent
  of status: a failed memory is still a saved memory.
- **Remembered time** — when the remembered *thing* happened, which may
  differ from when it was written down. Filled from confident,
  unambiguous dates only — "maybe 2024" stays uncertain.
- **Creation and update timestamps.**

Memories connect to **entities** (reusable people, places,
organizations, projects, topics, objects) through explicit, role-bearing
links, and to each other through typed **relations** — the graph
foundation the intelligence layer will traverse in later phases. Every
memory also records its **sources**: where it came from — typed words,
an image with its extracted text, a voice note with its transcript, a
document, a public link (Phase 9). Editing creates
**versions**, so a memory's history is as safe as its present. Full
details in `docs/memory-system.md`.

## 5. Experience principles

1. **Calm above all.** No noisy animations, no glowing gradients, no
   visual shouting. Motion exists only where it helps (entrance,
   confirmation, focus), and it is always subtle.
2. **Editorial, not technological.** The product should feel closer to a
   beautifully made journal or personal archive than to software.
   Typography leads; decoration follows.
3. **Honesty over delight-theater.** Nothing pretends. A disabled area
   says so. A not-yet-wired action responds truthfully. The system never
   fabricates success, and never invents memories.
4. **The user's words are sacred.** Original content is displayed and
   preserved verbatim. System understanding is always visually secondary
   to — and separable from — what the user actually wrote.
5. **Progressive depth.** The first memory should take ten seconds to
   keep. Power (structure, connections, questions) reveals itself as the
   archive grows.

## 6. Voice

Kept speaks like a thoughtful person, briefly. Warm but not gushing;
precise but not clinical. It says "keep," not "save to database." It says
"This space is still being prepared," not "Phase 2 pending." It never
uses exclamation marks, never says "Powered by AI," and never addresses
the user as "User."

## 7. Identity

**Kept** is the working product identity — short, warm, and literally
about keeping. The wordmark sets the name in Fraunces with a clay full
stop. The brand mark is a bookmark: the oldest tool for remembering a
place. The identity is intentionally easy to revisit later; it lives in
`src/config/app.ts` and `public/logo.svg`.
