/**
 * Gateway selection unit tests — the provider seam decides honestly
 * from AI_PROVIDER, and the semantic capability gate OPENS when the
 * Gemini provider is configured (the state the whole embedding seam
 * was designed to wait for). Uses the real SQLite repository behind
 * the seam; no network, no writes.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAiGateway, setAiGatewayForTests } from "@/lib/ai";

beforeEach(() => {
  setAiGatewayForTests(null);
});

afterEach(() => {
  setAiGatewayForTests(null);
  delete process.env.AI_PROVIDER;
});

describe("gateway provider selection", () => {
  it("selects the gemini provider when AI_PROVIDER=gemini", () => {
    process.env.GEMINI_API_KEY = "unit-test-key";
    process.env.AI_PROVIDER = "gemini";
    const gateway = getAiGateway();
    expect(gateway.providerId).toBe("gemini");
  });

  it("defaults to zai in development", () => {
    const gateway = getAiGateway();
    expect(gateway.providerId).toBe("zai");
  });

  it("fails honestly on an unknown provider name", () => {
    process.env.AI_PROVIDER = "does-not-exist";
    expect(() => getAiGateway()).toThrow(/not available/);
  });
});

describe("embedding capability gate", () => {
  it("opens with gemini configured (provider embeds + storage available)", () => {
    process.env.GEMINI_API_KEY = "unit-test-key";
    process.env.AI_PROVIDER = "gemini";
    const capability = getAiGateway().embeddingCapability();
    expect(capability).toEqual({ provider: true, storage: true, ready: true });
  });

  it("stays closed with zai configured (no embedding API)", () => {
    const capability = getAiGateway().embeddingCapability();
    expect(capability.ready).toBe(false);
    expect(capability.provider).toBe(false);
    expect(capability.storage).toBe(true);
  });
});
