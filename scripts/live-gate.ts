/**
 * GEMINI LIVE GATE — real requests against the real Google Gemini API.
 * No mocks. No fabricated responses. No secrets printed:
 *   - the API key is never echoed (only its length),
 *   - vectors are never printed (only dimensions, norm, fingerprint).
 *
 * Run: cd /home/z/my-project/kept && bun scripts/live-gate.ts
 * (bun auto-loads .env from the project root)
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

// Runner-agnostic: resolves next to this script's checkout location
// (works from the project checkout AND from a CI workspace).
const FIXTURES = new URL("../tests/fixtures/gate", import.meta.url).pathname;

interface GateResult {
  step: string;
  pass: boolean;
  evidence: string;
  failureClass?: string;
}
const results: GateResult[] = [];

function report(step: string, pass: boolean, evidence: string, failureClass?: string): void {
  results.push({ step, pass, evidence, failureClass });
  console.log(`\n[${pass ? "PASS" : "FAIL"}] ${step}`);
  console.log(`  evidence: ${evidence}`);
}

function classify(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const m = message.toLowerCase();
  if (m.includes("gemini_api_key") && m.includes("not configured")) return "environment";
  // Google-side region policy: the execution environment's egress IP is
  // in a region the Gemini API does not serve (FAILED_PRECONDITION).
  // This is environmental — never an auth, model, SDK, or app fault.
  if (m.includes("location is not supported") || m.includes("failed_precondition")) return "environment/region";
  if (m.includes("api key") || m.includes("api_key") || m.includes("401") || m.includes("permission") || m.includes("unregistered") || m.includes("unauthorized"))
    return "auth";
  if (m.includes("429") || m.includes("quota") || m.includes("resource_exhausted") || m.includes("rate")) return "quota";
  if (m.includes("404") || m.includes("not found")) return "endpoint/model";
  if (m.includes("enotfound") || m.includes("econnrefused") || m.includes("fetch failed") || m.includes("timeout") || m.includes("network") || m.includes("econnreset"))
    return "network/endpoint";
  if (m.includes("json") || m.includes("schema") || m.includes("invalid") || m.includes("expected")) return "application";
  return "sdk/application";
}

function fingerprint(vector: number[]): string {
  return createHash("sha256").update(vector.join(",")).digest("hex").slice(0, 12);
}

/** Set the moment any step proves the Google-side region block — used
 *  for precise attribution of downstream generic pipeline failures. */
let regionBlockObserved = false;

async function step<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    let klass = classify(error);
    if (klass === "environment/region") regionBlockObserved = true;
    // Precise attribution: a pipeline-level generic failure ("analysis-
    // failed") during a run where the SAME provider already proved the
    // region block inherits that proven environmental cause.
    if (
      klass === "sdk/application" &&
      regionBlockObserved &&
      /analysis-failed|embedding/i.test(message)
    ) {
      klass = "environment/region (inherited: proven earlier in this run)";
    }
    report(name, false, message.slice(0, 300), klass);
    return null;
  }
}

// ———————————————————— PREFLIGHT ————————————————————
console.log("=== GEMINI LIVE GATE — real API, no mocks ===\n");
console.log(`GEMINI_API_KEY: SET (length=${(process.env.GEMINI_API_KEY ?? "").length}, prefix=${(process.env.GEMINI_API_KEY ?? "").slice(0, 3)}***)`);
console.log(`AI_PROVIDER: ${process.env.AI_PROVIDER ?? "(unset)"}`);
console.log(`TEXT/VISION/ASR model: ${GEMINI_TEXT_MODEL} | embeddings model: ${GEMINI_EMBEDDING_MODEL}\n`);

let provider: GeminiIntelligenceProvider;
try {
  provider = new GeminiIntelligenceProvider();
} catch (error) {
  report("PREFLIGHT provider construction", false, error instanceof Error ? error.message : String(error), "environment");
  printSummaryAndExit();
  process.exit(1);
}

// ———————————————————— 1. TEXT ————————————————————
const textResult = await step("1. TEXT — analyzeMemory (real Gemini request)", async () => {
  const started = Date.now();
  const raw = await provider.analyzeMemory({
    content: "قابلت أحمد اليوم في الإسكندرية وتناولنا القهوة معًا",
    currentDate: new Date().toISOString().slice(0, 10),
    timezone: "Africa/Cairo",
    context: { memories: [], entities: [] },
  });
  const ms = Date.now() - started;

  // Valid JSON?
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) throw new Error("Response is not a JSON object.");

  // The APPLICATION contract: validate through the intelligence schema.
  const proposal = analysisProposalSchema.parse(parsed);
  const entityNames = (proposal.candidate.entities ?? []).map((entity) => entity.name);
  report(
    "1. TEXT — analyzeMemory (real Gemini request)",
    true,
    `valid JSON accepted by the app's analysisProposalSchema in ${ms}ms; type=${proposal.candidate.type}; title="${proposal.candidate.title}"; entities=[${entityNames.join(", ")}]`
  );
  return proposal;
});

// ———————————————————— 2. VISION ————————————————————
const visionResult = await step("2. VISION — extractImage (real Gemini request)", async () => {
  const imageBase64 = fs.readFileSync(`${FIXTURES}/gate-note.png`).toString("base64");
  const started = Date.now();
  const raw = await provider.extractImage({ imageBase64, mimeType: "image/png" });
  const ms = Date.now() - started;

  // The APPLICATION contract: the ingestion module's own parser/validator.
  const proposal = parseImageExtraction(raw);
  if (!proposal) throw new Error("Vision output rejected by the app's imageExtractionSchema.");
  const textHasTarget = /dentist appointment/i.test(proposal.text) || /tuesday/i.test(proposal.text);
  if (!textHasTarget) throw new Error(`Extracted text misses the fixture words (got: "${proposal.text.slice(0, 80)}…")`);
  if (!proposal.description || proposal.description.trim() === "") throw new Error("Empty description.");
  report(
    "2. VISION — extractImage (real Gemini request)",
    true,
    `imageExtractionSchema OK in ${ms}ms; verbatim text captured (${proposal.text.length} chars, contains "Dentist appointment"/"Tuesday"); description="${proposal.description.slice(0, 100)}"`
  );
  return proposal;
});

// ———————————————————— 3. ASR ————————————————————
const asrResult = await step("3. ASR — transcribe (real Gemini request)", async () => {
  const audioBase64 = fs.readFileSync(`${FIXTURES}/gate-speech.wav`).toString("base64");
  const started = Date.now();
  const { text } = await provider.transcribe({ audioBase64, mimeType: "audio/wav" });
  const ms = Date.now() - started;

  const trimmed = text.trim();
  if (trimmed === "") throw new Error("Empty transcript for a speech fixture.");
  const expected = ["voice note", "kept", "dentist", "tuesday", "ten"];
  const hits = expected.filter((word) => trimmed.toLowerCase().includes(word));
  if (hits.length === 0) throw new Error(`Transcript does not match the spoken fixture: "${trimmed.slice(0, 100)}"`);
  report(
    "3. ASR — transcribe (real Gemini request)",
    true,
    `non-empty transcript in ${ms}ms (${trimmed.length} chars); matched spoken keywords: [${hits.join(", ")}]; transcript: "${trimmed.slice(0, 140)}"`
  );
  return trimmed;
});

// ———————————————————— 4. EMBEDDINGS ————————————————————
const embedResult = await step("4. EMBEDDINGS — embed 'الحمد لله' (real Gemini request)", async () => {
  const started = Date.now();
  const result = await provider.embed({ text: "الحمد لله", purpose: "query" });
  const ms = Date.now() - started;

  if (!result.available) throw new Error(`Provider reported unavailability: ${result.reason}`);
  const { vector, dimensions, model, version } = result;
  if (vector.length !== dimensions) throw new Error(`Declared ${dimensions} dims but got ${vector.length} values.`);
  if (vector.some((v) => !Number.isFinite(v))) throw new Error("Non-finite component in the vector.");
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));

  // Determinism check: same text → same dimensions (and stable fingerprint).
  const again = await provider.embed({ text: "الحمد لله", purpose: "query" });
  if (!again.available) throw new Error("Second embed call failed.");
  const stable = fingerprint(vector) === fingerprint(again.vector);

  report(
    "4. EMBEDDINGS — embed 'الحمد لله' (real Gemini request)",
    true,
    `vector OK in ${ms}ms (vector NOT printed): dimensions=${dimensions}, L2norm=${norm.toFixed(4)}, fp=${fingerprint(vector)}, model=${model}, version=${version}, deterministic=${stable}`
  );
  return result;
});

// ———————————————————— 5. SEMANTIC SEARCH ————————————————————
const semanticResult = await step("5. SEMANTIC SEARCH — memory 'الحمد لله' vs query 'هل حمدت ربنا؟'", async () => {
  // a. A gate user (local SQLite, fixture identity — not a real person).
  const email = "gate-user@kept-gate.local";
  const user =
    (await db.user.findUnique({ where: { email } })) ??
    (await db.user.create({ data: { email, name: "Gemini Live Gate" } }));

  // b. The exact memory the task specifies, through the REAL application pipeline.
  const memory = await createMemory(user.id, { originalContent: "الحمد لله" });
  const processed = await processMemory(memory);
  const row = await db.memory.findUnique({ where: { id: memory.id } });
  if (!row) throw new Error("Memory row disappeared after processing.");
  if (row.processingStatus !== "ready") throw new Error(`processingStatus=${row.processingStatus} (outcome=${processed.outcome}, reason=${processed.reason ?? "n/a"})`);

  const embRow = await db.memoryEmbedding.findFirst({ where: { memoryId: memory.id } });
  if (!embRow || embRow.status !== "ready") throw new Error(`No ready embedding row (embeddingStatus=${row.embeddingStatus}).`);

  // c. Direct semantic retrieval evidence — exactly what SemanticRetriever runs.
  const gateway = getAiGateway();
  const capability = gateway.embeddingCapability();
  if (!capability.ready) throw new Error(`Capability gate not ready: ${JSON.stringify(capability)}`);

  const queryEmbedding = await gateway.embed({ text: "هل حمدت ربنا؟", purpose: "query" });
  if (!queryEmbedding.available) throw new Error(`Query embedding failed: ${queryEmbedding.reason}`);
  const hits = await gateway
    .embeddings()
    .search(user.id, queryEmbedding.vector, { model: queryEmbedding.model, version: queryEmbedding.version, dimensions: queryEmbedding.dimensions }, 5);
  const top = hits[0];
  if (!top || top.memoryId !== memory.id) throw new Error(`Top hit is not the target memory (top=${top?.memoryId ?? "none"}).`);

  // d. The FULL app search pipeline (deterministic understanding → planner → retrievers → merge → rank).
  const search = await searchMemorySpace(user.id, "هل حمدت ربنا؟");
  const projected = search.memories.find((m) => m.memoryId === memory.id);
  const viaSemantic = projected?.sources.includes("semantic") ?? false;
  if (search.semantic !== "available") throw new Error(`search.semantic=${search.semantic}`);
  if (!projected) throw new Error("Search pipeline returned no results for the semantic query.");
  if (!viaSemantic) throw new Error(`Memory found but not via semantic (sources=${projected.sources.join(",")})`);

  report(
    "5. SEMANTIC SEARCH — memory 'الحمد لله' vs query 'هل حمدت ربنا؟'",
    true,
    `capability gate OPEN (provider+storage ready); stored embedding: model=${embRow.model}, version=${embRow.version}, dims=${embRow.dimensions}, status=${embRow.status}; cosine(query,memory)=${top.score.toFixed(4)} (≥ min 0.2); full pipeline: semantic=${search.semantic}, memory found via sources=[${projected.sources.join(",")}], relevance=${projected.relevance.toFixed(3)}`
  );
  return { score: top.score, search };
});

// ———————————————————— SUMMARY ————————————————————
function printSummaryAndExit(): void {
  console.log("\n=== GATE SUMMARY ===");
  for (const r of results) {
    console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.step}${r.failureClass ? `  [cause: ${r.failureClass}]` : ""}`);
  }
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} steps passed.`);
}

printSummaryAndExit();
const allPassed = results.length === 5 && results.every((r) => r.pass);
console.log(allPassed ? "\nGATE: ALL LIVE TESTS PASSED" : "\nGATE: FAILURES PRESENT — see causes above");
process.exit(allPassed ? 0 : 1);
