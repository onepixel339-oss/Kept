# Kept — The Reasoning System (Phase 5)

Phase 5 closes the pipeline Phase 4 deliberately left open. Retrieval
produces a **ContextPack** — the ranked, provenance-carrying evidence
for one question (see `docs/query-system.md`). This document describes
what happens next: how that pack becomes a grounded natural-language
answer, how every claim is traceable, how the system behaves when
evidence is missing or contradictory, and how a conversation can touch
memory without ever letting a model mutate it.

The prime directive, unchanged since Phase 1:

> AI proposes → application validates → deterministic logic decides →
> the user reads only what survived.

---

## 1. Where reasoning sits

```
USER
 ↓
QUERY UNDERSTANDING      (AI proposal, validated; deterministic fallback)
 ↓
QUERY PLANNER            (deterministic, bounded)
 ↓
RETRIEVAL                (structured · keyword · entity · temporal · graph;
                          semantic honestly deferred)
 ↓
MERGE → RANK → CONTEXT BUILDER
 ↓
CONTEXT PACK             ← the Phase 4 / Phase 5 boundary
 ↓
INTENT ROUTING           (deterministic detection — see §7)
 ↓
REASONING                (this document: generate → ground → verify)
 ↓
ANSWER VERIFICATION      (AI audit + deterministic checks, bounded loop)
 ↓
FINAL ANSWER + PROVENANCE
 ↓
SAVE ASSISTANT MESSAGE   (final answer + provenance only — never hidden
                          reasoning, never prompts, never raw model output)
```

Two absolute rules bind everything below:

1. **Do not bypass the ContextPack.** The reasoning model receives the
   structured pack and nothing else. It never retrieves. There is no
   code path from the reasoning layer back to the database.
2. **Do not retrieve again inside the reasoning model.** If the pack is
   missing something, the answer says so — it never searches again
   behind the planner's back.

---

## 2. The AI contract: `generateAnswer()` / `verifyAnswer()`

Both operations live behind the AI gateway (`src/lib/ai/gateway.ts`)
as optional provider capabilities, exactly like `understandQuery`:

- `gateway.generateAnswer(request)` — receives the question, the
  structured pack (bounded projections: memory ids/titles/excerpts/
  dates, entities, relations, timeline, uncertainty notes), the
  bounded recent conversation, the current date/timezone, and — when
  regenerating — the previous attempt's verification feedback.
  Returns **raw JSON text**.
- `gateway.verifyAnswer(request)` — receives the question, the
  generated answer with its claims, and the **same** pack. Returns
  **raw JSON text**.

The provider implementations live in `lib/ai/providers/zai.ts` (the
only SDK import); prompt text lives in `src/prompts/answer-generation/v1.ts`
and `src/prompts/answer-verification/v1.ts` — versioned, immutable-once-
shipped assets. If a provider lacks a capability, the gateway reports
`{ available: false }` honestly and the pipeline falls back to its
deterministic behavior — never to a fabricated answer.

Every output is validated with zod before it is used
(`modules/reasoning/domain/answer-schemas.ts`):

- **Answer proposal**: `{ answer, claims[], uncertainties[],
  answer_style }` where each claim carries `{ text, type:
  "fact" | "inference", memory_ids[] }`. Fences and surrounding prose
  are tolerated; unknown fields are stripped; lengths and counts are
  capped (`config/reasoning.ts`).
- **Verification report**: `{ valid, unsupported_claims[],
  temporal_errors[], entity_errors[], source_mismatches[],
  required_changes[] }`.

A proposal that cannot be parsed is a normal, handled event — the loop
regenerates or composes deterministically. Unvalidated model text
never reaches the user or the conversation record.

---

## 3. Grounding — the deterministic law

The verification model is a second opinion; the grounding pass
(`modules/reasoning/domain/grounding.ts`) is the law. It runs on every
attempt, mechanically, before anything else judges the proposal:

1. **Fabricated provenance is discarded.** A claim citing a memory id
   that is not in the pack loses that id — the model can only reference
   what was actually shown to it (the same rule Phase 3 applied to
   model-referenced memories).
2. **A fact without support is not a fact.** A `fact` claim whose ids
   were all fabricated is demoted to an `inference` (interpretation)
   reading — never silently kept as fact.
3. **`no_evidence` answers carry no claims.** If the proposal claims
   honesty and then makes claims, the claims are dropped.
4. **The answer's provenance is exactly the union of surviving claim
   ids** — never the whole pack, never invented.
5. **Duplicate claims collapse** (normalized-text equality), because a
   model restating itself adds no information.

On top of grounding, `deterministicChecks()` adds structural audits
that need no model: empty-context answers may not carry claims; an
answer asserting a specific year while the pack holds only kept-date
proxies is flagged; every fabricated citation is reported as a source
mismatch even after the id is stripped.

---

## 4. The verification loop — bounded by construction

```
generateAnswer → validate schema → ground → verify (AI) + deterministic checks
      │                                        │
      │                               valid → return (status "passed")
      │                                        │
      └──────────── invalid ───────────→ regenerate ONCE, with the
                                       verification report as feedback
                                                │
                                     valid → return (status "regenerated")
                                                │
                                              still invalid
                                                ↓
                    CONSERVATIVE ANSWER: only the latest attempt's
                    claims that survived grounding and were not
                    flagged — composed deterministically. If none
                    survive, the honest partial-evidence line.
```

- **Maximum regeneration attempts: 1** (`config/reasoning.ts`
  `maxRegenerationAttempts`). The loop never runs indefinitely.
- The feedback given to the regeneration is the merged report (AI
  audit + deterministic checks), trimmed to a bounded number of issues.
- The conservative composition deliberately uses only the **latest**
  attempt's survivors: paraphrased retries of the same claim would
  read as repetition if merged across attempts.
- Verification statuses travel with the answer: `passed`,
  `regenerated`, `conservative`, `deterministic` — honest provenance
  for the whole reasoning run.

---

## 5. What the model is told (grounding rules)

The answer-generation prompt (`prompts/answer-generation/v1.ts`)
encodes the ten binding rules; future versions must preserve them:

1. A fact must be supported by retrieved memories.
2. Never invent a missing event.
3. Never invent a date.
4. Never invent a person/entity.
5. Never attribute a thought to the user unless a memory records it.
6. Never convert an inference into a user statement.
7. When evidence is insufficient, say so.
8. Preserve temporal uncertainty.
9. When sources conflict, acknowledge the conflict rather than choosing
   silently.
10. A memory supports a claim only if its actual text supports it.

Fact vs inference vs uncertainty (the prompt's taxonomy): a FACT is
something the user's own memories state; an INFERENCE is a reasonable
interpretation that must read as interpretation ("it seems that…") and
cites real memories; an UNCERTAINTY is what the memories do not
establish, returned in `uncertainties[]` and rendered as quiet
whispers in the UI.

---

## 6. Honest behavior: empty, partial, failed, conflicting

### Empty context (no memories retrieved)
No model call is made at all (cost discipline — see §10). The
deterministic honest line answers in the question's language:
"I couldn't find anything in your saved memories that answers that."
The system never hallucinates an answer because the user expects one.

### Partial evidence (memories exist but cannot answer)
Either the model answers cautiously and the verifier keeps it honest,
or — after two failed attempts — the conservative composition returns
the honest line: "I found a few related memories, but they don't
contain enough information to answer that confidently." The memories
themselves remain visible in the context list.

### Reasoning failed after retrieval succeeded
Provider unavailable, rate-limited (HTTP 429), or thrown: the answer is
a deterministic, retrieval-honest line ("I gathered the memories
related to your question, but couldn't compose them into a written
answer just now…") and the retrieved memories remain the answer
surface. The system may still expose the memories — it never invents.

### Conflicting memories
The prompt instructs the model to state both sides rather than pick
silently; the verifier flags "accidental certainty". Where dates
clarify a contradiction (a memory that was true and later stopped
being true), the answer explains the timeline. The UI additionally
surfaces the pack's own uncertainty notes (approximate windows,
fallback understanding, per-candidate ambiguity).

### Clarification over guessing
When the model cannot tell which saved thing a reference means (two
people named Ahmed, "هو"/"ده" unresolved), it returns
`answer_style: "clarification"` with a short question instead of a
guess. Ambiguity the retrieval layer found is surfaced separately with
links to each candidate.

---

## 7. Chat scopes and intent routing

The ask pipeline (`modules/query/application/ask-service.ts`) routes
every message through deterministic gates BEFORE any reasoning —
detection lives in `modules/query/domain/chat-intents.ts` and is
imperative-anchored so it cannot misfire on questions ("فاكر أحمد؟" is
a question; "افتكر إني…" is a capture):

| Detected intent | Path | Model calls |
|---|---|---|
| capture ("افتكر / احفظ / remember that…") | → memory module `createMemory` (verbatim); the **route** schedules the Memory Orchestrator via `after()`, exactly like `POST /api/memories` | 0 (understanding aside) |
| deletion ("احذف / امسح / delete…") | → existing `deleteMemory` flow **only when the target is unambiguous** (memory-scoped focus, or exactly one strongly-relevant candidate); otherwise a clarification listing candidates | 0 |
| count ("كام ذكرى / how many memories…") | → database count (window-aware via the temporal helper) | 0 |
| empty pack | → honest no-evidence line | 0 |
| plain structured find (intent `find`, no mentions, no reasoning needed) | → deterministic listing answer | 0 |
| everything else | → grounded reasoning (§4) | 2–4 (understand + generate×≤2 + verify×≤2) |

The model never decides to mutate memory: capture and deletion run
only on the user's explicit words, through the memory module's public
APIs, with ownership enforced there. Nothing in the reasoning layer
writes to the database.

### Scopes (spec §10–13)

`scope: global | memory | entity | topic` reuses the SAME planner and
retrievers — scope is an input, not a separate engine:

- **memory** — the focused memory enters retrieval as a structured
  read ("the memory you asked about"); the conversation is NOT trapped
  inside it: graph expansion and the rest of the plan may reach the
  memories around it ("What happened before this?").
- **entity / topic** — the focused entity/topic id is seeded into the
  entity retriever as a first-class source (basis `"scope"`), so a
  conversation about Ahmed retrieves Ahmed's memories even when the
  question doesn't name him. Foreign or unknown scope ids resolve to
  nothing (ownership re-verified by `getEntity`).
- **global** — the planner decides the retrieval scope; the whole
  database is never loaded.

Scopes are offered in the UI where focus naturally lives (the entry
points grew in Phase 6; see `docs/exploration-system.md` §6): "Ask
about this memory" on each memory page, "Talk about <name>" on every
person page, "Talk about <topic>" on every topic page, "Chat about
<entity>" on the entity-scoped search view, "Ask about this period" on
the timeline (global scope — the planner resolves the time window from
the question itself; the timeline UI adds no logic of its own), and
the global Ask page.

### Follow-ups (spec §14–15)

The conversation window is bounded (`config/query.budgets
.conversationWindow`, 8 turns). Understanding receives the recent
slices — user questions AND the assistant's honest records — so
references ("أقصد بتاع المشروع", "هو", "الموضوع ده") resolve against
the current scope, the recent conversation, the known entities, and
the retrieval context. The whole history is never loaded, and another
user's conversation yields an empty window (ownership-scoped reads).

### User corrections (spec §16)

Conversational corrections are treated as conversational content: they
may inform answers, but they do not silently rewrite memory. A
correction that represents an actual memory change reaches the Memory
Orchestrator only through explicit capture ("افتكر إني…") — the
existing memory pipeline remains the authority, with its validation,
resolution, and decision engine intact.

---

## 8. Provenance and persistence

The API response carries, for every ask:

```jsonc
{
  "answer": {
    "answer": "…",                      // the user-facing prose
    "claims": [                          // internal claims, grounded
      { "text": "…", "type": "fact", "memoryIds": ["cmu…"] }
    ],
    "supportingMemoryIds": ["cmu…"],     // union of claim ids, in-pack
    "supportingMemoryCount": 2,          // "Based on N memories"
    "uncertainties": ["…"],
    "answerStyle": "direct|summary|timeline|comparison|clarification|no_evidence",
    "verification": { "status": "passed|regenerated|conservative|deterministic", "issues": [] },
    "source": "ai|deterministic"
  },
  "action": { "kind": "captured|deleted|delete_clarification", … }
}
```

The UI renders this honestly and quietly: the answer as prose (bullets
supported), "Based on N memories" as a mono whisper, and a "View the
memories behind this" disclosure listing the supporting memories with
links to the originals — transparency without turning provenance into
an AI marketing badge. No model names, no token counts, no technical
retrieval labels appear anywhere.

The assistant's persisted message contains the **final answer text**
and a structured context record (intent, supporting memory ids,
entity ids, understanding source, plan iterations, answer style,
verification status, action). It never contains: prompts, raw model
output, hidden chain-of-thought, or internal diagnostics. The user's
own words are always stored verbatim.

---

## 9. What this phase does NOT do (boundary)

Phase 5 completes RETRIEVAL + REASONING + VERIFICATION + CHAT. It does
not add voice, file/image ingestion, external integrations,
notifications, agents, sharing, social features, calendars, or
assistant side-features. It also does not make the reasoning layer
retrieve: any future capability that would needs to go through the
planner, not around it.

---

## 10. Cost-control rules (free-product promise)

- Deterministic first: counts, listings, empty contexts, capture and
  deletion acknowledgements never invoke a model.
- The reasoning model is invoked only when synthesis actually helps
  (recall/summary/timeline/comparison/reflect/explore questions over a
  non-empty pack).
- Context is bounded: ≤30 memories per pack, ≤800-character verbatim
  excerpts per memory, ≤20 relations, ≤8 conversation turns.
- The verification loop is capped (1 regeneration); feedback lists are
  trimmed before reuse.
- All provider calls stay behind the gateway so the provider can be
  swapped or rate-limit behavior tuned in one place.

Phase 9 additions to the same promise (rich input — see
`docs/ingestion-system.md`):

- Rich input's AI use is bounded by construction: exactly ONE vision
  call per image and ONE ASR call per recording, both user-initiated
  at keep time; document and URL extraction are fully deterministic
  (zero AI calls — proven by counters in the test fixtures).
- Identical sources are never reprocessed: a stable client request id
  deduplicates ingestion, and retrying an already-extracted source is
  an honest no-op.
- What extraction produces (OCR text, transcripts) flows into the
  EXISTING pipeline as the user's own words — reasoning sees it as
  ordinary memory content with no new boundaries to bypass.

---

## 11. Known limitations (stated honestly)

- **No semantic retrieval beneath the answer.** Reasoning sees only
  the deterministic retrievers' results; recall can miss memories the
  keyword/entity/time strategies cannot express. When embeddings land
  (pgvector), the same pack gains a semantic leg — no reasoning
  redesign required.
- **Verification is model-augmented, not model-guaranteed.** The AI
  verifier can miss subtle unsupported claims; the deterministic layer
  guarantees only structural grounding (ids exist, facts are cited,
  styles are consistent). Language-quality repetition or paraphrase
  duplication inside a single model proposal is caught only when exact
  after normalization.
- **Provider rate limits are surfaced honestly.** Under HTTP 429 the
  user gets the deterministic fallback line and the memory list — never
  a queue, never a fabricated reply.
- **Conservative answers are deliberately plain.** After two failed
  verifications the composition joins surviving claim texts; it reads
  correctly but not as naturally as a verified generated answer.
- **Cross-language entity references still depend on understanding
  proposals** (the Phase 4 bridge): "المشروع" reaches the "website
  project" entity only when the model proposes the id and validation
  accepts it.

## 12. The AI data boundary under real accounts (Phase 7)

Phase 7 did not touch this pipeline's mechanics — it wrapped them.
What the model sees remains exactly the ContextPack (plus the
question): the few memories the user's own question retrieved. Under
real accounts this boundary gains a second lock: the user id that
scopes retrieval comes from the authenticated session, so the pack can
only ever contain the signed-in account's memories. The reasoning
layer still never retrieves, never writes, and never sees credentials,
session data, or anything outside the pack it was handed. Rate limits
(30 asks / 5 minutes per user) sit on the chat endpoint so refreshing
cannot multiply reasoning calls (see `docs/security.md` §9, §12).
