# Kept — Privacy

The product-level statement of what Kept stores, what it does with it,
and what it never does. This is the internal source of truth; the
public page `/privacy` says the same things in the product's voice.
No legal claims beyond what the system demonstrably does — the tests
verify most of these sentences directly.

## 1. What is stored

- The memories the user writes: their words (verbatim, forever), the
  derived title and summary, the memory type, the dates the user
  actually gave, and the processing state.
- What the system notices in them: entities (people, places,
  organizations, projects, topics, objects), memory↔entity links, and
  relations between them.
- Provenance: where each memory came from (user input today) and the
  validated decisions the application made while processing it.
- Conversations: the user's questions (verbatim) and the assistant's
  honest context records — what was retrieved and why, never invented
  answers.
- The account: email, hashed password (scrypt), session records
  (hashed tokens), and timestamps. Nothing else. No tracking pixels,
  no analytics, no third-party scripts.

## 2. What AI processing is used for

Understanding and answering — nothing else. Concretely: proposing a
title, summary, entities, and relations for a newly kept memory;
retrieving the small set of memories relevant to a question; proposing
a grounded answer from exactly those memories. The model proposes;
application logic validates and decides; the database persists. The
AI never writes to the database and never mutates memory.

## 3. What may reach the AI provider

Only the minimum text needed for the operation at hand:

- the content of the memory just written (plus the small pool of
  candidate memories compared against it, owned by the same user), or
- the ContextPack for a question: the few memories the deterministic
  pipeline retrieved for that user's question.

Phase 9 adds two narrow, user-initiated cases: an image the user is
keeping right now (sent as a data URI to extract its visible text),
and a recording the user is keeping right now (sent to produce their
transcript). Both see only user-owned bytes, only when the owner
keeps them, and only through the gateway.

Never: another account's memories, a full copy of the database,
authentication secrets, session cookies, password material, internal
security data, or internal prompts. The ContextPack boundary is
structural (Phase 4/5) and unchanged by Phase 7.

## 4. Who can see the memories

The account owner. Every query is scoped by the authenticated user id;
accessing another account's data is indistinguishable from asking for
something that does not exist. There are no shared feeds, no public
pages, no rankings, no "social" anything.

Phase 9 keeps this true for rich sources: preserved originals (photos,
recordings, documents) are private by default — stored outside the web
root under opaque keys and reachable ONLY through authenticated,
ownership-checked routes. Another user's source is indistinguishable
from one that does not exist.

## 5. Deletion

- Deleting a memory removes it, its version history, its links, its
  relations, and its provenance — through the existing cascade.
- Deleting the account removes everything that belongs to it in one
  transactional sweep — memories, entities, links, relations, sources,
  chats, analyses, sessions, reset tokens, the account row — verified
  complete after the fact. Deletion is real, not a flag.
- No soft-delete shadows, no "removed" residues, no retention beyond
  the delete itself.

## 6. Export

`Settings → Data → Export` produces a complete JSON copy of the
account: memories with their full history, entities, memory↔entity
links, relations, sources, and conversations. Machine-readable, no
permission slips required, rate-limited only against abuse. Password
hashes, sessions, and internal analysis machinery are deliberately
excluded (see `docs/security.md` §6).

## 7. Logging

Operational facts only — that a request happened, how long it took,
whether it failed, and stable error codes. Not passwords, not session
tokens, not reset tokens, not the content of memories. Query logging
is off by default for the same reason (parameters can echo private
values).

## 8. What Kept does not do

- No third-party analytics or tracking of any kind.
- No sharing, publishing, or "social" surface of any kind.
- No model training on user data — the provider processes a request
  and the system stores only the validated proposals the application
  accepted.
- No hidden data retention after deletion, and no copies outside the
  account's database and the export file the user downloads.
