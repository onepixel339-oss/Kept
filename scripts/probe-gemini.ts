/**
 * Minimal Gemini endpoint probe — classify live API behavior per endpoint.
 * Prints NO secrets: key length only, error classes + status codes.
 * Run: bun scripts/probe-gemini.ts
 */
import { GoogleGenAI } from "@google/genai";

const key = process.env.GEMINI_API_KEY?.trim() ?? "";
console.log(`key: SET (length=${key.length})`);
const ai = new GoogleGenAI({ apiKey: key });

// ——— Probe A: generateContent with gemini-3.8-flash ———
try {
  const r = await ai.models.generateContent({
    model: "gemini-3.8-flash",
    contents: "Reply with exactly: OK",
  });
  console.log(`A generateContent(gemini-3.8-flash): OK — text="${(r.text ?? "").trim().slice(0, 40)}"`);
} catch (e) {
  console.log(`A generateContent(gemini-3.8-flash): ERROR ${String(e).slice(0, 220)}`);
}

// ——— Probe B: generateContent with gemini-2.5-flash (control) ———
try {
  const r = await ai.models.generateContent({ model: "gemini-2.5-flash", contents: "Reply with exactly: OK" });
  console.log(`B generateContent(gemini-2.5-flash): OK — "${(r.text ?? "").trim().slice(0, 40)}"`);
} catch (e) {
  console.log(`B generateContent(gemini-2.5-flash): ERROR ${String(e).slice(0, 220)}`);
}

// ——— Probe C: embedContent with gemini-embedding-001 ———
try {
  const r = await ai.models.embedContent({ model: "gemini-embedding-001", contents: "الحمد لله" });
  const dims = r.embeddings?.[0]?.values?.length ?? 0;
  console.log(`C embedContent(gemini-embedding-001): OK — dims=${dims}`);
} catch (e) {
  console.log(`C embedContent(gemini-embedding-001): ERROR ${String(e).slice(0, 220)}`);
}

// ——— Probe D: list models reachable by this key (names only) ———
try {
  const page = await ai.models.list({ config: { pageSize: 100 } });
  const names: string[] = [];
  for await (const m of page) {
    if (m.name) names.push(m.name.replace("models/", ""));
  }
  const interesting = names.filter((n) => /flash|embedding|flash-lite/i.test(n)).slice(0, 25);
  console.log(`D models.list: OK — ${names.length} models visible; flash/embedding family: [${interesting.join(", ")}]`);
} catch (e) {
  console.log(`D models.list: ERROR ${String(e).slice(0, 220)}`);
}
