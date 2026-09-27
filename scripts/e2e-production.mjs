/**
 * Production-style E2E against the built standalone server.
 * Run AFTER: npm run build && server started on PORT 3210.
 * No mocks: real HTTP, real DB, real AI attempts — and STRICT honest
 * expectations per environment:
 *   E2E_AI_EXPECTATION=live    → the provider IS reachable (CI runner in
 *                                a supported region): AI outcomes must
 *                                SUCCEED (ready / semantic hit).
 *   E2E_AI_EXPECTATION=blocked → the provider is region-blocked (this
 *                                sandbox): AI outcomes must fail HONESTLY
 *                                (failed / kept / never fabricated).
 * There is deliberately no permissive mode: one that accepts anything
 * would hide real failures.
 *
 * bun scripts/e2e-production.mjs
 */
const BASE = process.env.E2E_BASE ?? "http://localhost:3210";
const AI_EXPECTATION = (process.env.E2E_AI_EXPECTATION ?? "blocked").trim().toLowerCase();
const EMAIL = `e2e-gate-${Date.now()}@kept-e2e.local`;
const PASSWORD = "E2ePass123!";
const FIXTURES = new URL("../tests/fixtures/gate", import.meta.url).pathname;

const results = [];
function report(name, pass, evidence) {
  results.push({ name, pass, evidence });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name} — ${evidence}`);
}

function getCookie(response) {
  const cookies = response.headers.getSetCookie?.() ?? [];
  const session = cookies.find((c) => c.startsWith("kept_session="));
  return session ? session.split(";")[0] : null;
}

async function main() {
  // 1. Health: server is up.
  const home = await fetch(`${BASE}/login`);
  report("server responds (production standalone)", home.status === 200, `GET /login → ${home.status}`);

  // 2. Signup → session cookie.
  const signup = await fetch(`${BASE}/api/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, name: "E2E Gate" }),
  });
  const cookie = getCookie(signup);
  report(
    "signup 201 + session cookie",
    signup.status === 201 && Boolean(cookie),
    `POST /api/auth/signup → ${signup.status}; kept_session cookie: ${cookie ? "SET (value hidden)" : "MISSING"}`
  );
  const authHeaders = { Cookie: cookie ?? "" };

  // 3. Text memory: "الحمد لله" (the semantic-search seed).
  const create = await fetch(`${BASE}/api/memories`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ originalContent: "الحمد لله" }),
  });
  const createBody = await create.json().catch(() => ({}));
  const memoryId = createBody?.memory?.id ?? createBody?.data?.memory?.id;
  report(
    "create text memory 201 (processing pending)",
    create.status === 201 && Boolean(memoryId),
    `POST /api/memories → ${create.status}; memoryId=${memoryId ?? "?"}; processingStatus=${createBody?.memory?.processingStatus ?? createBody?.data?.memory?.processingStatus ?? "?"}`
  );

  // 4. Background intelligence runs against REAL Gemini. Terminal
  //    outcomes are strict per environment: live → ready (real AI
  //    success), blocked → failed (kept, honest, never fabricated).
  //    Poll until terminal instead of a fixed sleep.
  const deadline = Date.now() + 45_000;
  let list, kept, status = "pending";
  do {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    list = await fetch(`${BASE}/api/memories`, { headers: authHeaders });
    const listBody = await list.json().catch(() => ({}));
    const memories = listBody?.data?.items ?? listBody?.items ?? [];
    kept = Array.isArray(memories) ? memories.find((m) => m.id === memoryId) : null;
    status = kept?.processingStatus ?? "not-found";
  } while (Date.now() < deadline && status !== "ready" && status !== "failed");
  const expectedStatus = AI_EXPECTATION === "live" ? "ready" : "failed";
  report(
    `text ingestion → real AI processing (${AI_EXPECTATION} expectation)`,
    list.status === 200 && Boolean(kept) && status === expectedStatus,
    `GET /api/memories → ${list.status}; memory kept=${Boolean(kept)}; processingStatus=${status}; expected=${expectedStatus} (E2E_AI_EXPECTATION=${AI_EXPECTATION})`
  );

  // 5. Deterministic search always works. With the provider live, the
  //    REAL proof is retrieval: the memory must come back via the
  //    semantic source (real embeddings end-to-end). With the provider
  //    blocked: gate open + failure contained, no crash, no fabrication.
  const search = await fetch(`${BASE}/api/search?q=${encodeURIComponent("هل حمدت ربنا؟")}`, { headers: authHeaders });
  const searchBody = await search.json().catch(() => ({}));
  const semantic = searchBody?.data?.semantic ?? searchBody?.semantic;
  const searchMemories = searchBody?.data?.memories ?? searchBody?.memories ?? [];
  const projected = Array.isArray(searchMemories) ? searchMemories.find((m) => (m.memoryId ?? m.id) === memoryId) : null;
  const viaSemantic = projected?.sources?.includes("semantic") ?? false;
  const searchOk =
    search.status === 200 &&
    ["available", "deferred"].includes(semantic) &&
    (AI_EXPECTATION === "live" ? viaSemantic : true);
  report(
    AI_EXPECTATION === "live"
      ? "search 200 — memory retrieved via REAL semantic embeddings"
      : "search 200 — semantic gate open, live embed failure contained, no crash",
    searchOk,
    `GET /api/search?q=هل حمدت ربنا؟ → ${search.status}; semantic=${semantic}; memory found=${Boolean(projected)} via sources=[${projected?.sources?.join(",") ?? "-"}] (expectation=${AI_EXPECTATION})`
  );

  // 6. Image ingest: original preserved; AI extraction attempts live Gemini.
  const imageForm = new FormData();
  imageForm.set("kind", "image");
  imageForm.set("caption", "ملاحظة الحفلة");
  imageForm.set(
    "file",
    new Blob([await (await import("node:fs/promises")).readFile(`${FIXTURES}/gate-note.png`)], { type: "image/png" }),
    "gate-note.png"
  );
  const ingestImage = await fetch(`${BASE}/api/ingest`, { method: "POST", headers: authHeaders, body: imageForm });
  const imageBody = await ingestImage.json().catch(() => ({}));
  const imagePayload = imageBody?.data ?? imageBody;
  const imageSource = imagePayload?.sources?.[0] ?? imagePayload?.source;
  report(
    "image ingest — upload + source preserved",
    ingestImage.ok && Boolean(imageSource?.id),
    `POST /api/ingest (image) → ${ingestImage.status}; sourceId=${imageSource?.id ?? "?"}; extractionStatus=${imageSource?.extractionStatus ?? "?"} (caption present → user text is the content; AI extraction not required)`
  );

  // 7. Audio ingest: original preserved; live transcription attempted.
  const audioForm = new FormData();
  audioForm.set("kind", "audio");
  audioForm.set("durationSeconds", "7.3");
  audioForm.set(
    "file",
    new Blob([await (await import("node:fs/promises")).readFile(`${FIXTURES}/gate-speech.wav`)], { type: "audio/wav" }),
    "gate-speech.wav"
  );
  const ingestAudio = await fetch(`${BASE}/api/ingest`, { method: "POST", headers: authHeaders, body: audioForm });
  const audioBody = await ingestAudio.json().catch(() => ({}));
  const audioPayload = audioBody?.data ?? audioBody;
  const audioSource = audioPayload?.sources?.[0] ?? audioPayload?.source;
  const expectedExtraction = AI_EXPECTATION === "live" ? "ready" : "failed";
  report(
    `audio ingest — upload + source preserved, live ASR (${AI_EXPECTATION})`,
    ingestAudio.ok && Boolean(audioSource?.id) && audioSource?.extractionStatus === expectedExtraction,
    `POST /api/ingest (audio) → ${ingestAudio.status}; sourceId=${audioSource?.id ?? "?"}; extractionStatus=${audioSource?.extractionStatus ?? "?"}; expected=${expectedExtraction} (no caption → live ASR required; expectation=${AI_EXPECTATION})`
  );

  // 8. Server still healthy after every AI outcome (no crash).
  const healthy = await fetch(`${BASE}/api/memories`, { headers: authHeaders });
  report("server healthy after all AI outcomes", healthy.status === 200, `GET /api/memories → ${healthy.status}`);

  // ——— Summary ———
  const passed = results.filter((r) => r.pass).length;
  console.log(`\nE2E: ${passed}/${results.length} checks passed.`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((error) => {
  console.error("E2E crashed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
