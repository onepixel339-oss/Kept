/**
 * Gemini provider unit tests — the provider's CONTRACT behavior with a
 * stubbed GoogleGenAI transport. These tests prove the mapping, the
 * honesty rules (never fabricate), and the request shapes. They are
 * unit tests only; live behavior is proven by scripts/live-gate.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { generateContent, embedContent } = vi.hoisted(() => ({
  generateContent: vi.fn(),
  embedContent: vi.fn(),
}));

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent, embedContent };
  },
}));

import { GeminiIntelligenceProvider } from "@/lib/ai/providers/gemini";
import { MEMORY_ANALYSIS_PROMPT_V1 } from "@/prompts/memory-analysis/v1";
import { IMAGE_EXTRACTION_PROMPT_V1 } from "@/prompts/image-extraction/v1";

const KEY = "unit-test-key";

beforeEach(() => {
  process.env.GEMINI_API_KEY = KEY;
  generateContent.mockReset();
  embedContent.mockReset();
});

afterEach(() => {
  delete process.env.GEMINI_API_KEY;
});

describe("GeminiIntelligenceProvider — capability flags", () => {
  it("declares the honest capability surface", () => {
    const provider = new GeminiIntelligenceProvider();
    expect(provider.id).toBe("gemini");
    expect(provider.embeds).toBe(true);
    expect(provider.visions).toBe(true);
    expect(provider.transcribes).toBe(true);
    // Gemini has no hosted page reader — the flag must stay false.
    expect(provider.readsPages).toBe(false);
  });

  it("fails honestly when GEMINI_API_KEY is missing (no mock, no fallback)", () => {
    delete process.env.GEMINI_API_KEY;
    expect(() => new GeminiIntelligenceProvider()).toThrow(/GEMINI_API_KEY is not configured/);
  });
});

describe("GeminiIntelligenceProvider — embed", () => {
  it("maps the SDK response into the EmbedResult contract", async () => {
    embedContent.mockResolvedValue({ embeddings: [{ values: [0.1, -0.2, 0.3] }] });
    const provider = new GeminiIntelligenceProvider();

    const result = await provider.embed({ text: "الحمد لله", purpose: "query" });
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.vector).toEqual([0.1, -0.2, 0.3]);
    expect(result.dimensions).toBe(3);
    expect(result.model).toBe("gemini-embedding-001");
    expect(result.version).toBe("v1");
    expect(embedContent).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gemini-embedding-001", contents: "الحمد لله" })
    );
  });

  it("reports unavailability — never a fabricated vector — when the API errors", async () => {
    embedContent.mockRejectedValue(new Error("User location is not supported for the API use."));
    const provider = new GeminiIntelligenceProvider();

    const result = await provider.embed({ text: "hello", purpose: "memory", memoryId: "m1" });
    expect(result.available).toBe(false);
    if (result.available) return;
    expect(result.reason).toContain("location");
  });

  it("reports unavailability when the SDK returns no values", async () => {
    embedContent.mockResolvedValue({ embeddings: [] });
    const provider = new GeminiIntelligenceProvider();
    const result = await provider.embed({ text: "hello", purpose: "query" });
    expect(result.available).toBe(false);
  });

  it("reports unavailability on non-finite components", async () => {
    embedContent.mockResolvedValue({ embeddings: [{ values: [0.1, Number.NaN] }] });
    const provider = new GeminiIntelligenceProvider();
    const result = await provider.embed({ text: "hello", purpose: "query" });
    expect(result.available).toBe(false);
  });
});

describe("GeminiIntelligenceProvider — text analysis", () => {
  it("sends the versioned prompt as system instruction and returns raw JSON text", async () => {
    generateContent.mockResolvedValue({ text: '{"candidate":{"type":"conversation"}}' });
    const provider = new GeminiIntelligenceProvider();

    const raw = await provider.analyzeMemory({
      content: "قابلت أحمد اليوم",
      currentDate: "2026-09-27",
      timezone: "Africa/Cairo",
      context: { memories: [], entities: [] },
    });

    expect(raw).toBe('{"candidate":{"type":"conversation"}}');
    const call = generateContent.mock.calls[0][0];
    expect(call.model).toBe("gemini-3.8-flash");
    expect(call.config.systemInstruction).toBe(MEMORY_ANALYSIS_PROMPT_V1);
    expect(call.config.responseMimeType).toBe("application/json");
    expect(call.contents[0].parts[0].text).toContain("قابلت أحمد اليوم");
  });

  it("throws on an empty completion instead of inventing output", async () => {
    generateContent.mockResolvedValue({ text: "" });
    const provider = new GeminiIntelligenceProvider();
    await expect(
      provider.analyzeMemory({
        content: "x",
        currentDate: "2026-09-27",
        timezone: "UTC",
        context: { memories: [], entities: [] },
      })
    ).rejects.toThrow(/empty response/);
  });
});

describe("GeminiIntelligenceProvider — vision + audio", () => {
  it("passes the image as inline data with its mime type under the extraction prompt", async () => {
    generateContent.mockResolvedValue({ text: '{"text":"KEPT GATE TEST NOTE","description":"a note"}' });
    const provider = new GeminiIntelligenceProvider();

    const raw = await provider.extractImage({ imageBase64: "QUJD", mimeType: "image/png" });
    expect(raw).toContain("KEPT GATE TEST NOTE");

    const call = generateContent.mock.calls[0][0];
    expect(call.config.systemInstruction).toBeUndefined();
    expect(call.contents[0].parts[0].text).toBe(IMAGE_EXTRACTION_PROMPT_V1);
    expect(call.contents[0].parts[1].inlineData).toEqual({ mimeType: "image/png", data: "QUJD" });
  });

  it("returns the trimmed transcript from the audio request", async () => {
    generateContent.mockResolvedValue({ text: "  Hello, this is a voice note.  " });
    const provider = new GeminiIntelligenceProvider();

    const { text } = await provider.transcribe({ audioBase64: "QUJD", mimeType: "audio/wav" });
    expect(text).toBe("Hello, this is a voice note.");

    const call = generateContent.mock.calls[0][0];
    expect(call.contents[0].parts[1].inlineData).toEqual({ mimeType: "audio/wav", data: "QUJD" });
  });
});
