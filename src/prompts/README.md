# Prompts

Prompts are product assets, not strings scattered through code. They live
in this folder, versioned and reviewable, and are the only place where
prompt text is allowed to exist.

## Organization (current)

```
prompts/
  memory-analysis/      # understanding proposals for one memory
    v1.ts               # one version per module; versions are immutable once shipped
  memory-comparison/    # comparing a candidate against existing memories/entities
    v1.ts
  query-understanding/  # Phase 4: understanding a user's question (intent,
    v1.ts               #   mentions, time, depth) — retrieval planning input
  image-extraction/     # Phase 9: what a user-owned image contains (verbatim
    v1.ts               #   readable text + one factual sentence; no invented
                        #   facts — extraction, never interpretation)
  answer-generation/    # Phase 5: composing a grounded answer FROM a ContextPack
    v1.ts               #   (claims cite pack memory ids; honest no-evidence; the
                        #   ten grounding rules are binding here)
  answer-verification/  # Phase 5: auditing a generated answer against the same
    v1.ts               #   pack (unsupported claims, temporal/entity errors)
```

Prompt assets are TypeScript modules exporting a single template
constant — no executable logic, no I/O, no imports beyond types. This
keeps them type-safe, reviewable in diffs, and loadable without runtime
file resolution (which standalone builds complicate).

## Rules

1. **Prompts propose, never decide.** Prompt output must always map onto
   the validated proposal schemas (`modules/intelligence/domain/ai-schemas.ts`)
   or a similarly narrow proposal type. No prompt may instruct the AI
   to "save", "update", "merge", or "delete" anything.
2. **No user content is interpolated into a prompt file.** Prompts are
   templates; runtime values are passed as structured inputs by the AI
   gateway.
3. **A prompt version is immutable.** Changes create a new version so old
   memories remain explainable by the prompt that understood them.
4. **Prompts are reviewed like code.** They shape what the product
   believes about the user's memories.
5. **Prompts encode the safety rules.** Preserve the distinction between
   what the user said and what the model infers; never invent people,
   places, dates, or events; preserve uncertainty; opinions stay
   thoughts. These rules bind every future version.
