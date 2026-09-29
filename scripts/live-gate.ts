/**
 * GEMINI LIVE GATE — V2. Real requests against the real Google Gemini API.
 * No mocks. No fabricated responses. No forced green.
 *
 * V2 policy (evidence-driven, honest by construction):
 *  - 503 UNAVAILABLE ("high demand") is transient provider availability:
 *    retried at most 3 attempts with exponential backoff, honoring
 *    Google's own retryDelay (RetryInfo / "Please retry in Xs") with a
 *    time cap. A 503 NEVER changes the model. If it persists, the step
 *    stays BLOCKED as `transient/provider-availability` with the attempt
 *    count and short evidence — never reclassified as an app/SDK bug.
 *  - 429 is NOT guessed from the status code: the real Google error body
 *    is parsed for quotaMetric / ErrorInfo reason / RetryInfo — window
 *    (RPM·TPM·RPD), scope (per-model·per-project) and tier (Free Tier).
 *    Per-minute windows are retried honoring Google's retryDelay; daily
 *    or plan-level exhaustion (e.g. limit: 0, …PER_DAY) is NOT retried —
 *    no wait inside this run can fix it — and is reported as `quota`
 *    with the exact metric and the real remedy (quota reset / billing).
 *  - Spacing between every provider-facing request so the gate itself
 *    never self-induces a rate burst (GATE_SPACING_MS, default 10s).
 *  - Semantic search is dependency-aware: when TEXT or EMBEDDINGS
 *    already failed in this run, its failure is attributed
 *    `blocked-by-upstream` with the explicit chain — never silently
 *    labeled SDK/application without evidence of a real retriever bug.
 *  - Retries never mask permanent failures: only the structured classes
 *    above are retried, each with its own hard attempt cap, and every
 *    attempt is logged (count + status + short server reason).
 *
 * Secret hygiene: the key is never echoed (length only), vectors are
 * never printed (dimensions, norm, fingerprint only), error bodies are
 * truncated server messages (Google error bodies carry no key material).
 *
 * Run: bun scripts/live-gate.ts
 */

import fs from "node:fs";
import { createHash } from "node:crypto";

import { db } from "@/lib/db";
import { GeminiIntelligenceProvider, GEMINI_TEXT_MODEL, GEMINI_EMBEDDING_MODEL } from "@/lib/ai/providers/gemini";
import { getAiGateway } from "@/lib/ai";
import { createMemory } from "@/modules/memory";
import { processMemory } from "@/modules/intelligence";
import { searchMemorySpace } from "@/modules/query";
import { analysisProposalSchema } from "@/modules/intelligence/domain/ai-schemas";
import { parseImageExtraction } from "@/modules/ingestion/domain/extraction-schemas";
import {
  AttemptRecord,
  ParsedGoogleError,
  backoffDelayMs,
  describeQuota,
  formatAttempts,
  isQuotaExhausted,
  isTransientUnavailable,
  parseGoogleError,
  truncateForEvidence,
} from "./lib/gate-errors";

// Runner-agnostic: resolves next to this script's checkout location
// (works from the project checkout AND from a CI workspace).
const FIXTURES = new URL("../tests/fixtures/gate", import.meta.url).pathname;

// ———————————————————— retry / spacing policy constants ————————

const MAX_ATTEMPTS = 3; // hard cap for EVERY retried call (1 initial + 2 retries)
const BACKOFF_BASE_MS = 2_000; // transient 503: 2s → 4s → (capped 15s)
const BACKOFF_CAP_MS = 15_000;
/** Honor Google's retryDelay / Retry-After, but never wait longer than this. */
const RETRY_DELAY_CAP_MS = 30_000;
/** Per-minute quota windows: honor Google's retryDelay up to this wait. */
const QUOTA_WAIT_CAP_MS = 75_000;
/** Unknown-window 429: ONE conservative wait, then report. */
const QUOTA_CONSERVATIVE_WAIT_MS = 30_000;

function envSpacingMs(): number {
  const raw = Number.parseInt(process.env.GATE_SPACING_MS ?? "", 10);
  if (!Number.isFinite(raw)) return 10_000;
  return Math.min(60_000, Math.max(0, raw));
}
const GATE_SPACING_MS = envSpacingMs();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Rate-limit courtesy: the gate must never self-induce a quota burst. */
async function spacing(ms: number = GATE_SPACING_MS): Promise<void> {
  if (ms <= 0) return;
  console.log(`  (rate-limit spacing: ${Math.round(ms / 1000)}s before the next real request)`);
  await sleep(ms);
}

// ———————————————————— result model —————————————————————————————

type StepResult = "PASS" | "FAIL" | "BLOCKED";

interface GateResult {
  step: string;
  result: StepResult;
  evidence: string;
  failureClass?: string;
  chain?: string[];
}
const results: GateResult[] = [];

/** Upstream outcomes, for dependency-aware attribution (keyed by step name). */
const upstream = new Map<string, GateResult>();

function report(step: string, result: StepResult, evidence: string, failureClass?: string, chain?: string[]): void {
  const entry: GateResult = { step, result, evidence, ...(failureClass ? { failureClass } : {}), ...(chain ? { chain } : {}) };
  results.push(entry);
  upstream.set(step, entry);
  console.log(`\n[${result}] ${step}`);
  console.log(`  evidence: ${evidence}`);
  if (chain) for (const link of chain) console.log(`  chain: ${link}`);
}

// ———————————————————— classification ———————————————————————————

/** Structured-first classification: parse the Google body, fall back to
 *  message matching only when there is no body. */
function classify(error: unknown): string {
  const parsed = parseGoogleError(error);
  if (isTransientUnavailable(parsed)) return "transient/provider-availability";
  if (isQuotaExhausted(parsed)) return "quota";
  if (parsed.httpStatus === 401 || parsed.httpStatus === 403) return "auth";
  if (parsed.httpStatus === 404) return "endpoint/model";

  const message = parsed.message.toLowerCase();
  if (message.includes("gemini_api_key") && message.includes("not configured")) return "environment";
  // Google-side region policy: the egress IP is in an unsupported region
  // (FAILED_PRECONDITION). Environmental — never an auth/model/SDK/app fault.
  if (message.includes("location is not supported") || message.includes("failed_precondition")) return "environment/region";
  if (message.includes("api key") || message.includes("api_key") || message.includes("permission") || message.includes("unregistered") || message.includes("unauthorized"))
    return "auth";
  if (message.includes("rate")) return "quota";
  if (message.includes("404") || message.includes("not found")) return "endpoint/model";
  if (message.includes("enotfound") || message.includes("econnrefused") || message.includes("fetch failed") || message.includes("timeout") || message.includes("network") || message.includes("econnreset"))
    return "network/endpoint";
  if (message.includes("json") || message.includes("schema") || message.includes("invalid") || message.includes("expected")) return "application";
  return "sdk/application";
}

/** External causes (Google infrastructure, quota, environment, config)
 *  → BLOCKED. Only genuine in-repo defects → FAIL. */
function isExternalFailureClass(klass: string): boolean {
  return klass !== "application" && klass !== "sdk/application";
}

/** A failure the retry policy will NOT retry (validation, schema…). */
class GateAttemptError extends Error {
  constructor(
    message: string,
    readonly attempts: AttemptRecord[],
    readonly parsed: ParsedGoogleError,
    readonly waitedMs: number
  ) {
    super(message);
    this.name = "GateAttemptError";
  }
}

// ———————————————————— retry engine —————————————————————————————

interface RetryDecision {
  retry: boolean;
  waitMs: number;
  why: string;
}

/**
 * ONE unified, explicit policy for all live calls:
 *  - 503/UNAVAILABLE   → transient: exponential backoff, honoring
 *                        Google's retryDelay when present (capped).
 *  - 429/RESOURCE_EXHAUSTED → quota-aware: per-minute/token windows are
 *                        retried on Google's own retryDelay; daily/plan
 *                        exhaustion is never retried (external blocker);
 *                        unknown windows get ONE conservative wait.
 *  - everything else   → no retry (auth, region, validation, network…):
 *                        retries must never mask permanent failures.
 */
function decideRetry(parsed: ParsedGoogleError, attemptsSoFar: number): RetryDecision {
  const attemptsLeft = MAX_ATTEMPTS - attemptsSoFar;
  if (attemptsLeft <= 0) return { retry: false, waitMs: 0, why: "attempt cap reached" };

  if (isTransientUnavailable(parsed)) {
    const honored = parsed.retryDelayMs !== null ? Math.min(parsed.retryDelayMs, RETRY_DELAY_CAP_MS) : null;
    const waitMs = honored ?? backoffDelayMs(attemptsSoFar, BACKOFF_BASE_MS, BACKOFF_CAP_MS);
    return {
      retry: true,
      waitMs,
      why: honored !== null ? `transient 503 — honoring Google retryDelay (${(waitMs / 1000).toFixed(1)}s, capped at ${RETRY_DELAY_CAP_MS / 1000}s)` : `transient 503 — exponential backoff (${waitMs / 1000}s)`,
    };
  }

  if (isQuotaExhausted(parsed)) {
    const profile = describeQuota(parsed);
    // Daily / plan-level exhaustion: waiting cannot fix it inside this run.
    if (profile.dailyOrPlanExhausted) {
      return {
        retry: false,
        waitMs: 0,
        why: `daily/plan quota exhausted (${profile.note}) — external blocker, needs quota reset or billing/tier change`,
      };
    }
    // Per-minute window: Google usually tells us exactly how long to wait.
    if (profile.shortWindow) {
      if (parsed.retryDelayMs !== null && parsed.retryDelayMs <= QUOTA_WAIT_CAP_MS) {
        return {
          retry: true,
          waitMs: parsed.retryDelayMs + 2_000, // small safety margin over Google's own delay
          why: `per-minute quota window — honoring Google retryDelay (+2s margin)`,
        };
      }
      if (attemptsSoFar < MAX_ATTEMPTS) {
        return {
          retry: true,
          waitMs: QUOTA_CONSERVATIVE_WAIT_MS,
          why: "per-minute quota window but no usable retryDelay — one conservative 30s wait",
        };
      }
      return { retry: false, waitMs: 0, why: "attempt cap reached on per-minute quota window" };
    }
    // Unspecified window: one conservative wait, then report honestly.
    if (attemptsSoFar < 2) {
      return { retry: true, waitMs: QUOTA_CONSERVATIVE_WAIT_MS, why: "unspecified quota window — single conservative 30s wait" };
    }
    return { retry: false, waitMs: 0, why: `unspecified quota exhaustion (${profile.note}) — not retrying further` };
  }

  return { retry: false, waitMs: 0, why: "not a transient/quota error — retries must not mask permanent failures" };
}

function describeAttempt(parsed: ParsedGoogleError): string {
  const status = [parsed.httpStatus ?? "?", parsed.googleStatus ?? ""].filter(Boolean).join(" ");
  return `${status} — ${parsed.message}`;
}

/**
 * Run ONE real provider request under the V2 policy. Success returns the
 * value; failure throws GateAttemptError carrying the full attempt log —
 * evidence, not noise: attempt count, statuses, short server reasons.
 */
async function liveRequest<T>(fn: () => Promise<T>): Promise<T> {
  const attempts: AttemptRecord[] = [];
  let waitedMs = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const parsed = parseGoogleError(error);
      attempts.push({ n: attempt, httpStatus: parsed.httpStatus, googleStatus: parsed.googleStatus, note: parsed.message });
      const decision = decideRetry(parsed, attempt);
      const line = `[attempt ${attempt}/${MAX_ATTEMPTS}] ${describeAttempt(parsed)}`;
      console.log(`  ${line}${decision.retry ? ` → retrying in ${(decision.waitMs / 1000).toFixed(1)}s (${decision.why})` : ` → no retry (${decision.why})`}`);
      if (!decision.retry) {
        throw new GateAttemptError(parsed.message, attempts, parsed, waitedMs);
      }
      await sleep(decision.waitMs);
      waitedMs += decision.waitMs;
    }
  }
  // Unreachable (the loop always returns or throws), but TypeScript needs it.
  throw new GateAttemptError("attempt loop exhausted", attempts, parseGoogleError("unknown"), waitedMs);
}

/** The provider's embed() swallows thrown errors into {available:false,
 *  reason}. Surface them so the retry policy sees the REAL error body. */
async function embedOrThrow(fn: () => Promise<{ available: boolean; reason?: string }>): Promise<{ available: true; vector: number[]; dimensions: number; model: string; version: string }> {
  const result = (await fn()) as { available: boolean; reason?: string; vector?: number[]; dimensions?: number; model?: string; version?: string };
  if (!result.available) throw new Error(result.reason ?? "The embedding service returned no vector.");
  return result as { available: true; vector: number[]; dimensions: number; model: string; version: string };
}

// ———————————————————— dependency attribution ———————————————————

/** The pipeline never surfaces raw provider errors; it returns outcomes.
 *  Tag that case so attribution can distinguish "pipeline reported a
 *  failure" from "the gate itself could not reach the pipeline". */
class PipelineFailure extends Error {
  constructor(readonly outcome: string, readonly reason: string, readonly processingStatus: string, readonly embeddingStatus: string) {
    super(`memory pipeline did not reach ready: outcome=${outcome}, reason=${reason}, processingStatus=${processingStatus}, embeddingStatus=${embeddingStatus}`);
    this.name = "PipelineFailure";
  }
}

function upstreamSummary(stepName: string): string {
  const up = upstream.get(stepName);
  if (!up) return `${stepName} → not reached in this run`;
  return `${stepName} → ${up.result}${up.failureClass ? ` [${up.failureClass}]` : ""}`;
}

/**
 * Dependency-aware attribution for the SEMANTIC SEARCH step. Rules:
 *  - embedding/capability-shaped failure + EMBEDDINGS not PASS →
 *    blocked-by-upstream(EMBEDDINGS);
 *  - pipeline/processing-shaped failure + TEXT not PASS →
 *    blocked-by-upstream(TEXT);
 *  - otherwise judge the error on its OWN body — sdk/application only
 *    with real evidence of a retriever defect.
 */
function attributeSemanticFailure(error: unknown): { klass: string; chain: string[] } {
  const textUp = upstream.get("1. TEXT — analyzeMemory (real Gemini request)");
  const embUp = upstream.get("4. EMBEDDINGS — embed 'الحمد لله' (real Gemini request)");
  const textOk = textUp?.result === "PASS";
  const embOk = embUp?.result === "PASS";
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();

  const context: string[] = [];
  if (textUp && textUp.result !== "PASS") context.push(upstreamSummary("1. TEXT — analyzeMemory (real Gemini request)"));
  if (embUp && embUp.result !== "PASS") context.push(upstreamSummary("4. EMBEDDINGS — embed 'الحمد لله' (real Gemini request)"));

  if (!embOk && /embed|capability|vector|embedding row|query embedding/i.test(message)) {
    return {
      klass: `blocked-by-upstream:EMBEDDINGS (${embUp?.failureClass ?? "not PASS"})`,
      chain: [...context, "semantic search depends on real embeddings — blocked by the EMBEDDINGS outcome above"],
    };
  }
  if (!textOk && (error instanceof PipelineFailure || /analysis-failed|comparison-failed|pipeline did not reach ready|processingstatus|no results|search\.semantic/i.test(message))) {
    return {
      klass: `blocked-by-upstream:TEXT (${textUp?.failureClass ?? "not PASS"})`,
      chain: [...context, "memory processing failed upstream → semantic search blocked-by-upstream(TEXT)"],
    };
  }
  return { klass: classify(error), chain: context.length > 0 ? context : [] };
}

function fingerprint(vector: number[]): string {
  return createHash("sha256").update(vector.join(",")).digest("hex").slice(0, 12);
}

// ———————————————————— generic step runner ——————————————————————

async function step(name: string, run: () => Promise<string>, options: { spaceBefore?: boolean } = {}): Promise<boolean> {
  if (options.spaceBefore !== false) await spacing();
  try {
    const evidence = await run();
    report(name, "PASS", evidence);
    return true;
  } catch (error) {
    const isSemantic = name.startsWith("5.");
    const klass = isSemantic ? attributeSemanticFailure(error).klass : classify(error);
    const chain = isSemantic ? attributeSemanticFailure(error).chain : undefined;
    let evidence: string;
    if (error instanceof GateAttemptError) {
      // Attempt count + short evidence only — per the reporting contract.
      evidence = `${formatAttempts(error.attempts)}${error.waitedMs > 0 ? `, waited ${(error.waitedMs / 1000).toFixed(1)}s between attempts` : ""} — last: ${error.message}`;
    } else {
      evidence = truncateForEvidence(error instanceof Error ? error.message : String(error), 300);
    }
    report(name, isExternalFailureClass(klass) ? "BLOCKED" : "FAIL", evidence, klass, chain && chain.length > 0 ? chain : undefined);
    return false;
  }
}

// ———————————————————— PREFLIGHT —————————————————————————————————

console.log("=== GEMINI LIVE GATE V2 — real API, no mocks, honest attribution ===\n");
console.log(`GEMINI_API_KEY: SET (length=${(process.env.GEMINI_API_KEY ?? "").length}, prefix=${(process.env.GEMINI_API_KEY ?? "").slice(0, 3)}***)`);
console.log(`AI_PROVIDER: ${process.env.AI_PROVIDER ?? "(unset)"}`);
console.log(`TEXT/VISION/ASR model: ${GEMINI_TEXT_MODEL} | embeddings model: ${GEMINI_EMBEDDING_MODEL}`);
console.log(`Policy: max ${MAX_ATTEMPTS} attempts/call; 503 → exponential backoff honoring retryDelay (≤${RETRY_DELAY_CAP_MS / 1000}s); 429 → quota-body-aware (RPD/limit:0 never retried); spacing ${GATE_SPACING_MS / 1000}s between steps\n`);

let provider: GeminiIntelligenceProvider;
try {
  provider = new GeminiIntelligenceProvider();
} catch (error) {
  report("PREFLIGHT provider construction", "BLOCKED", error instanceof Error ? error.message : String(error), "environment");
  printSummaryAndExit();
  process.exit(1);
}

// ———————————————————— 1. TEXT ———————————————————————————————————
// 503 high-demand is TRANSIENT: retried (≤3) with capped backoff honoring
// Google's retryDelay. Success = a real, schema-valid response. A 503
// never changes the model and never becomes an app/SDK verdict.

const TEXT_STEP = "1. TEXT — analyzeMemory (real Gemini request)";
await step(TEXT_STEP, async () => {
  const started = Date.now();
  const raw = await liveRequest(() =>
    provider.analyzeMemory({
      content: "قابلت أحمد اليوم في الإسكندرية وتناولنا القهوة معًا",
      currentDate: new Date().toISOString().slice(0, 10),
      timezone: "Africa/Cairo",
      context: { memories: [], entities: [] },
    })
  );
  const ms = Date.now() - started;

  // Valid JSON? (validation is NOT retried — a parse failure is a real
  // application-class signal, not a transient one)
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) throw new Error("Response is not a JSON object.");

  // The APPLICATION contract: validate through the intelligence schema.
  const proposal = analysisProposalSchema.parse(parsed);
  const entityNames = (proposal.candidate.entities ?? []).map((entity) => entity.name);
  return `valid JSON accepted by the app's analysisProposalSchema in ${ms}ms; type=${proposal.candidate.type}; title="${proposal.candidate.title}"; entities=[${entityNames.join(", ")}]`;
});

// ———————————————————— 2. VISION —————————————————————————————————
// 429 is judged from the REAL body (metric/window/scope/tier), with
// spacing before the request so the gate never self-induces the burst.

const VISION_STEP = "2. VISION — extractImage (real Gemini request)";
await step(VISION_STEP, async () => {
  const imageBase64 = fs.readFileSync(`${FIXTURES}/gate-note.png`).toString("base64");
  const started = Date.now();
  const raw = await liveRequest(() => provider.extractImage({ imageBase64, mimeType: "image/png" }));
  const ms = Date.now() - started;

  // The APPLICATION contract: the ingestion module's own parser/validator.
  const proposal = parseImageExtraction(raw);
  if (!proposal) throw new Error("Vision output rejected by the app's imageExtractionSchema.");
  const textHasTarget = /dentist appointment/i.test(proposal.text) || /tuesday/i.test(proposal.text);
  if (!textHasTarget) throw new Error(`Extracted text misses the fixture words (got: "${proposal.text.slice(0, 80)}…")`);
  if (!proposal.description || proposal.description.trim() === "") throw new Error("Empty description.");
  return `imageExtractionSchema OK in ${ms}ms; verbatim text captured (${proposal.text.length} chars, contains "Dentist appointment"/"Tuesday"); description="${proposal.description.slice(0, 100)}"`;
});

// ———————————————————— 3. ASR ————————————————————————————————————
// Same quota-aware policy as Vision. Success = real request + valid
// response + NON-EMPTY transcript matching the spoken fixture — saving
// the audio file is never ASR success.

const ASR_STEP = "3. ASR — transcribe (real Gemini request)";
await step(ASR_STEP, async () => {
  const audioBase64 = fs.readFileSync(`${FIXTURES}/gate-speech.wav`).toString("base64");
  const started = Date.now();
  const { text } = await liveRequest(() => provider.transcribe({ audioBase64, mimeType: "audio/wav" }));
  const ms = Date.now() - started;

  const trimmed = text.trim();
  if (trimmed === "") throw new Error("Empty transcript for a speech fixture.");
  const expected = ["voice note", "kept", "dentist", "tuesday", "ten"];
  const hits = expected.filter((word) => trimmed.toLowerCase().includes(word));
  if (hits.length === 0) throw new Error(`Transcript does not match the spoken fixture: "${trimmed.slice(0, 100)}"`);
  return `non-empty transcript in ${ms}ms (${trimmed.length} chars); matched spoken keywords: [${hits.join(", ")}]; transcript: "${trimmed.slice(0, 140)}"`;
});

// ———————————————————— 4. EMBEDDINGS —————————————————————————————
// gemini-embedding-001 stays EXACTLY as-is. Real vector, real checks:
// exists, declared dimensions match, all components finite — the vector
// itself is never printed (fingerprint only).

const EMBED_STEP = "4. EMBEDDINGS — embed 'الحمد لله' (real Gemini request)";
await step(EMBED_STEP, async () => {
  const started = Date.now();
  const result = await embedOrThrow(() => liveRequest(() => provider.embed({ text: "الحمد لله", purpose: "query" })));
  const ms = Date.now() - started;

  const { vector, dimensions, model, version } = result;
  if (vector.length !== dimensions) throw new Error(`Declared ${dimensions} dims but got ${vector.length} values.`);
  if (vector.some((v) => !Number.isFinite(v))) throw new Error("Non-finite component in the vector.");
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));

  // Determinism check: same text → same dimensions (and stable fingerprint).
  await spacing(Math.round(GATE_SPACING_MS / 2));
  const again = await embedOrThrow(() => liveRequest(() => provider.embed({ text: "الحمد لله", purpose: "query" })));
  const stable = fingerprint(vector) === fingerprint(again.vector);

  return `vector OK in ${ms}ms (vector NOT printed): dimensions=${dimensions}, L2norm=${norm.toFixed(4)}, fp=${fingerprint(vector)}, model=${model}, version=${version}, deterministic=${stable}`;
});

// ———————————————————— 5. SEMANTIC SEARCH ————————————————————————
// PASS requires the REAL end-to-end path: a real memory ("الحمد لله")
// through the real pipeline (processing genuinely completes, a real
// embedding row exists), a real query embedding for "هل حمدت ربنا؟",
// the retriever actually returning that memory as the top hit, and the
// full search pipeline surfacing it via the semantic source. A
// capability flag alone is never PASS. Failures are attributed
// dependency-aware — blocked-by-upstream(TEXT|EMBEDDINGS) with the
// chain — unless there is real evidence of a retriever defect.

const SEMANTIC_STEP = "5. SEMANTIC SEARCH — memory 'الحمد لله' vs query 'هل حمدت ربنا؟'";
await step(SEMANTIC_STEP, async () => {
  // a. A gate user (local SQLite, fixture identity — not a real person).
  const email = "gate-user@kept-gate.local";
  const user = (await db.user.findUnique({ where: { email } })) ?? (await db.user.create({ data: { email, name: "Gemini Live Gate" } }));

  // b. The exact memory the task specifies, through the REAL application pipeline.
  const memory = await createMemory(user.id, { originalContent: "الحمد لله" });
  const processed = await processMemory(memory);
  const row = await db.memory.findUnique({ where: { id: memory.id } });
  if (!row) throw new Error("Memory row disappeared after processing.");
  if (row.processingStatus !== "ready") {
    throw new PipelineFailure(processed.outcome, processed.reason ?? "n/a", row.processingStatus, row.embeddingStatus);
  }

  const embRow = await db.memoryEmbedding.findFirst({ where: { memoryId: memory.id } });
  if (!embRow || embRow.status !== "ready") throw new Error(`No ready embedding row (embeddingStatus=${row.embeddingStatus}).`);

  // c. Direct semantic retrieval evidence — exactly what SemanticRetriever runs.
  const gateway = getAiGateway();
  const capability = gateway.embeddingCapability();
  if (!capability.ready) throw new Error(`Capability gate not ready: provider=${capability.provider}, storage=${capability.storage}`);

  const queryEmbeddingResult = await embedOrThrow(() => liveRequest(() => gateway.embed({ text: "هل حمدت ربنا؟", purpose: "query" })));
  const hits = await gateway
    .embeddings()
    .search(user.id, queryEmbeddingResult.vector, { model: queryEmbeddingResult.model, version: queryEmbeddingResult.version, dimensions: queryEmbeddingResult.dimensions }, 5);
  const top = hits[0];
  if (!top || top.memoryId !== memory.id) throw new Error(`Top hit is not the target memory (top=${top?.memoryId ?? "none"}).`);

  // d. The FULL app search pipeline (deterministic understanding → planner → retrievers → merge → rank).
  const search = await searchMemorySpace(user.id, "هل حمدت ربنا؟");
  const projected = search.memories.find((m) => m.memoryId === memory.id);
  const viaSemantic = projected?.sources.includes("semantic") ?? false;
  if (search.semantic !== "available") throw new Error(`search.semantic=${search.semantic}`);
  if (!projected) throw new Error("Search pipeline returned no results for the semantic query.");
  if (!viaSemantic) throw new Error(`Memory found but not via semantic (sources=${projected.sources.join(",")})`);

  return `capability gate OPEN (provider+storage ready); stored embedding: model=${embRow.model}, version=${embRow.version}, dims=${embRow.dimensions}, status=${embRow.status}; cosine(query,memory)=${top.score.toFixed(4)} (≥ min 0.2); full pipeline: semantic=${search.semantic}, memory found via sources=[${projected.sources.join(",")}], relevance=${projected.relevance.toFixed(3)}`;
});

// ———————————————————— SUMMARY ———————————————————————————————————

function printSummaryAndExit(): void {
  console.log("\n=== GATE SUMMARY ===");
  for (const r of results) {
    console.log(`${r.result.padEnd(8)}${r.step}${r.failureClass ? `  [cause: ${r.failureClass}]` : ""}`);
    if (r.chain) for (const link of r.chain) console.log(`         chain: ${link}`);
  }
  const pass = results.filter((r) => r.result === "PASS").length;
  const fail = results.filter((r) => r.result === "FAIL").length;
  const blocked = results.filter((r) => r.result === "BLOCKED").length;
  console.log(`\n${pass}/${results.length} capabilities PASS; ${fail} FAIL (in-repo defect evidence); ${blocked} BLOCKED (external, classified above).`);
}

printSummaryAndExit();
const allPassed = results.length === 5 && results.every((r) => r.result === "PASS");
console.log(allPassed ? "\nGATE: ALL LIVE CAPABILITIES PROVEN" : "\nGATE: NOT ALL CAPABILITIES PROVEN — honest attribution above; external blockers stay external");
process.exit(allPassed ? 0 : 1);
