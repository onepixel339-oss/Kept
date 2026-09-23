# Kept — Ingestion System (Phase 9)

> Rich memory input & unified ingestion. The user should be able to give
> the application information naturally — text, an image, a voice note, a
> document, a public link — and every direction converges into ONE
> pipeline that ends at the existing Memory Orchestrator. There is no
> second memory system, and the intelligence remains mostly invisible.

## 1. Position and the one rule

```
INPUT (any modality)
  ↓
INGESTION        modules/ingestion — extract, normalize, preserve
  ↓
NORMALIZATION    NormalizedIngestion — one shape for every modality
  ↓
MEMORY PIPELINE  modules/memory — createMemoryWithSources (atomic)
  ↓
MEMORY INTELLIGENCE  unchanged Phase 3 pipeline (analyze → compare → decide)
  ↓
MEMORY CORE      sources + memories + memory_sources
```

**The rule (spec CORE RULE):** all modalities produce a normalized
ingestion object and hand it to the existing pipeline. Nothing here
creates a "Rich Memory Orchestrator"; no modality has private memory
logic. Text input runs through the same abstraction (`ingestText`) —
and the untouched `/api/memories` route keeps its byte-for-byte
behavior for typed notes.

## 2. The modules and their boundaries

| Layer | Files | Knows about |
|---|---|---|
| domain | `ingestion-types`, `compose`, `ssrf`, `html-text`, `validation`, `extraction-schemas` | pure rules; no I/O |
| application | `ingestion-service`, `retry-service` | orchestration; memory module's public API only |
| infrastructure | `image-extractor`, `audio-transcriber`, `document-extractor`, `pdf-text`, `url-extractor`, `source-repository` | sharp, zlib, gateway calls, Prisma-for-sources |

The memory module never learns how PDFs, audio, images, or URLs are
parsed — it receives **plain source seeds** (`SourceSeed`) and stores
provenance atomically with the memory. The AI is only ever reached
through the gateway (`lib/ai`).

## 3. Modality contracts

### 3.1 Text (existing path, unified)
`ingestText` validates and clamps typed words (512 KB cap) and records
the classic `user_input` source. `/api/memories` remains the composer's
text route — unchanged.

### 3.2 Image (spec §4–6)
Order of operations, bounded at every step:

1. size cap 10 MB (config, before deep reads)
2. **content signature** via magic bytes (PNG/JPEG/WebP/GIF) — the
   client-declared MIME is a hint, never trusted (spec §13)
3. decode via `sharp` — proves the bytes are a real image; corrupted
   uploads stop here
4. **preserve the original** + a 512 px WebP thumbnail in the storage
   seam — before any extraction
5. ONE vision call (`gateway.extractImage`) proposing
   `{ text, description }` — validated by the domain zod schema

Honest outcomes: capability unavailable → `pending` (image kept,
retryable); provider error / invalid proposal → `failed` (image STILL
kept, spec §36); empty text → `ready` with what was truly there. The
prompt forbids inference — "Meeting on September 30" is extracted,
"The user was happy" is never invented (spec §4).

### 3.3 Audio / voice (spec §7–9)
- size cap 25 MB; signature detection (WAV/MP3/MP4-AAC/WebM/OGG)
- original preserved FIRST — the transcript never replaces it
- transcription via `gateway.transcribe` (SDK ASR — real, probe-verified)
- unavailable → `pending` with the recording intact; error → `failed`,
  recording intact; empty transcript → `ready` + "No speech was
  detected" (silence is honest)
- duration: parsed from WAV headers server-side; other formats accept a
  client-reported hint stored as such
- the composer records via MediaRecorder and converts to 16 kHz mono
  WAV in the browser (deterministic; the ASR backend accepts it
  everywhere). When the microphone is unavailable, the composer says so
  quietly and offers the file path instead.

### 3.4 Documents (spec §10–13)
Formats: `.txt`, `.md` (direct bounded read), `.pdf` and `.docx`
(both extracted locally and deterministically — no AI, no paid
dependency, spec §33):

- **PDF** (`pdf-text.ts`): scans content streams, unwraps
  ASCII85, inflates FlateDecode, reads the text-showing operators
  (`Tj`/`TJ`/`'`/`T*`/`TD`). Deliberately NOT a full PDF interpreter:
  scanned pages and exotic encodings honestly yield "no readable text
  layer" instead of garbage. Output bounded at 50k chars.
- **DOCX**: a minimal ZIP reader (central-directory parse + zlib
  inflate, STORED and DEFLATE) reading `word/document.xml`, then an XML
  text strip. No zip library dependency.

The original file is preserved BEFORE extraction; a document longer
than the bound extracts as `partial` with an honest warning (spec §12).

### 3.5 URL (spec §14–16)
Security posture, enforced in order — see `domain/ssrf.ts`:

1. scheme whitelist — **http/https only**; `file:`, `ftp:`, `data:`,
   `javascript:` and everything else rejected
2. standard ports only (80/443)
3. DNS resolution with **every record** checked against loopback,
   private, link-local (incl. cloud metadata 169.254.169.254), CGNAT,
   benchmarking, multicast/reserved, and IPv4-mapped IPv6 ranges; a
   hostname resolving to ANY private address is rejected (no pinning
   games); localhost/.local/.internal names rejected by name
4. bounded local fetch: 10 s timeout, 5 MB response cap, **manual
   redirects where EVERY hop re-passes the full validation**
5. only readable content types parsed (`text/html`,
   `application/xhtml+xml`, `text/plain`); the parser never executes
   anything and is bounded on input and output
6. if the local fetch fails, the provider's hosted page reader
   (`gateway.readPage`) is tried — the URL was already validated, so
   private addresses never reach any external service either

Failure never fabricates a summary: the URL itself is preserved as the
source, marked `failed`, retryable (spec §16, §36).

## 4. Source model & provenance (spec §17, §21)

`sources` is the central provenance layer:

| Column | Meaning |
|---|---|
| `source_type` | `user_input` \| `file` \| `image` \| `voice` \| `url` \| `conversation` |
| `raw_content` | the captured words: typed text, transcript, or extracted text |
| `extraction_status` | `pending` \| `processing` \| `ready` \| `partial` \| `failed` |
| `extraction_error` | stable, human-safe; never raw internals |
| `storage_key` | opaque storage-seam key for the preserved original (never a path) |
| `dedup_key` | stable client request id → idempotent ingestion |
| `metadata` | JSON: filename, dimensions, duration, page title, extraction tool, warnings… |

`memory_sources` (many-to-many) links memories to sources. One memory
may come from several sources (a screenshot + the user's caption,
spec §20); a source may back more than one memory. The legacy
`referenceId` stays in sync for compatibility; pre-Phase-9 rows keep
working (their `user_input` sources are `ready` by default).

**Ingestion status vs memory status (spec §18):** a memory can be
`active` while its source's extraction is `partial` — "the memory
exists, but some processing of its input was incomplete." The memory's
`processing_status` (intelligence) is a different axis entirely.

## 5. Multi-source memories (spec §20)

A caption typed beside an upload becomes a second source on the SAME
memory. The memory's words are composed by `domain/compose.ts`:

- user words first, verbatim; extracted text second, verbatim
- both → `origin: user_text_plus_extracted`, joined by a blank line
- neither → a machine description only for images, marked
  `machine_description` in metadata — never presented as user words
- still nothing → **no memory is created**; the source is preserved
  unlinked until a successful retry gives it words

No duplicates are created here: the existing Memory Intelligence
decides related/additive/update/duplicate/conflict, exactly as for
typed input (spec §20).

## 6. Storage (spec §29–30)

`lib/storage` — a five-operation seam (`put/get/delete/exists/size`)
with a local adapter for development (files under `storage/uploads/`,
outside `public/`; override with `INGESTION_STORAGE_ROOT`). Keys are
generated server-side from safe characters (`u/<userId>/<yyyy>/<mm>/<random>.<ext>`);
user-controlled filenames never become storage paths; every operation
re-validates keys against traversal. Nothing is publicly served —
originals stream only through **GET /api/sources/[id]/file** (and
`?variant=thumb` for thumbnails), which authenticates, checks
ownership, sends `private, no-store` + `nosniff`, and never exposes
the key or path. A future object-storage adapter swaps in without
touching the application.

## 7. Retry & idempotency (spec §37)

- **Ingestion**: a client-supplied `requestId` maps to one source via
  `dedup_key` — repeating a request returns the original outcome
  (no duplicate sources, memories, entities).
- **Retry** (`POST /api/sources/[id]/retry`): claims the source
  atomically (`processing` guard — concurrent retries collapse),
  re-extracts from the PRESERVED original, updates the same row in
  place. A source already linked to a memory keeps that memory's words
  exactly as kept — retry completes provenance, it never rewrites a
  memory. An unlinked source that now extracts creates exactly ONE
  memory (re-checked inside the claim) and attaches the SAME source.
- Deterministic extraction (documents, URLs) makes retries cheap and
  stable; images and audio re-propose only from identical stored bytes.

## 8. Delete behavior (spec §28)

Deleting a memory collects its sources (join + legacy referenceId),
keeps any source another *existing* memory still references, deletes
the rest, and removes their preserved originals + thumbnails from
storage AFTER the transaction commits. No orphans; a storage failure
is logged and never blocks the user's delete.

## 9. Limits (spec §31) — documented defaults

| Limit | Default |
|---|---|
| max image | 10 MB |
| max audio | 25 MB |
| max file | 20 MB |
| max typed text | 512 KB |
| URL response | 5 MB (→ ≤20k chars of text) |
| URL timeout / redirects | 10 s / 3 (each hop re-validated) |
| URL ports / schemes | 80, 443 / http, https |
| image thumbnail | 512 px WebP |
| extraction text caps | image 8k · audio 20k · document 50k chars |
| extraction timeouts | document 20 s · vision 30 s · ASR 60 s |

## 10. Cost control (spec §33) & AI boundary (§34)

- extraction is deterministic wherever possible: documents and URLs
  make ZERO AI calls (proven by fixture counters in tests)
- exactly ONE vision call per image; exactly one ASR call per recording
- identical sources are never reprocessed (dedup key; retry no-ops)
- retries are bounded and rate limited
- no user API keys; provider credentials stay server-side behind
  `lib/ai`; the client never sees model names, prompts, or internals
- capabilities are declared honestly and were **verified against the
  real SDK at runtime before wiring** (vision: printed text extracted
  from a probe image; ASR: well-formed transcript response;
  page_reader: HTML + title). Providers without a capability report it
  and the pipeline degrades to `pending` — never a fabricated result.

## 11. Rate limiting (spec §32)

`ingest: 30 / 5 min / user` joins the Phase 7 table (uploads, OCR,
transcription, and URL fetches are expensive); retries use the
existing `process` rule. No new rate-limit mechanism.

## 12. UI (spec §22–27)

- **Unified composer**: one calm question, four quiet doors (Image,
  Mic, Clip, Link) beside the field — different ways of adding a
  memory, not separate products. No five giant upload buttons.
- **Drag & drop** onto the composer classifies the file; **paste**
  handles clipboard images and files without duplicating browser
  behavior; links get a small inline entry.
- **Preview before saving**: image thumbnail, filename, size — nothing
  uploads without the user's explicit Keep.
- **Processing UX stays quiet**: "Saving…" → "Saved." / "Partially
  processed — …" / "Couldn't read it — kept the original, you can
  retry" with a small Try again. Never "AI is analyzing your file…".
- **Source inspection** on memory detail ("Where it came from"):
  image thumbnails (authenticated), audio players, file downloads,
  external links, the exact text that was read, and honest failure
  lines with retry. No hidden prompts, no model internals, no storage
  paths — ever.

## 13. Tests (spec §38)

`tests/ingestion.test.ts` — 37 tests mapping all 22 required
behaviors on the real SQLite database through the application
services: text continuity, image/MIME validation, ownership and
cross-user isolation, audio validation and the transcription boundary
(unavailable + failing providers), document extraction (txt/md, DOCX
STORED+DEFLATE, real PDF fixture), unsupported rejection, URL
validation, SSRF (localhost, private ranges, metadata, mapped IPv6,
no-pinning DNS), redirect re-validation (safe follow + private-block,
injected DNS/fetch — zero network), provenance views, multi-source
memories, dedup, failure-preservation, retry idempotency, oversized
files, shared-source delete safety, deterministic extraction with AI
call counters, HTML parsing bounds, and honest capability deferral.

## 14. Limitations (explicit)

- PDF extraction reads text-layer PDFs; scanned/image PDFs report
  honestly and stay retryable if a future OCR-for-documents capability
  lands. Complex CJK/CID encodings degrade to "no readable text"
  rather than garbage.
- Audio duration is parsed from WAV only; other formats rely on the
  client-reported hint (labeled as such).
- The URL fetcher reads static HTML; pages that require JavaScript
  fall back to the hosted reader and otherwise fail honestly.
- Voice capture requires browser microphone permission; denied or
  unavailable microphones surface a quiet notice with the file path.
- Rate limiting remains per-process (documented Phase 7 debt).
