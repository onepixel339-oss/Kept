/**
 * Vector seam unit tests — encode/decode round trip + cosine honesty.
 * Pure functions; no database, no network.
 */
import { describe, expect, it } from "vitest";
import { cosineSimilarity, decodeVector, encodeVector } from "@/lib/ai/sqlite-embeddings";

describe("encodeVector / decodeVector", () => {
  it("round-trips a float vector exactly (little-endian Float32)", () => {
    const vector = [1.5, -2.25, 0, 3.14159, 1e-8, -9.75];
    const decoded = decodeVector(encodeVector(vector));
    expect(decoded).toHaveLength(vector.length);
    for (let i = 0; i < vector.length; i++) {
      expect(decoded[i]).toBeCloseTo(vector[i], 6);
    }
  });

  it("preserves dimensionality through the byte encoding", () => {
    const vector = new Array(3072).fill(0).map((_, i) => Math.sin(i) * 0.01);
    const bytes = encodeVector(vector);
    expect(bytes.byteLength).toBe(3072 * 4);
    expect(decodeVector(bytes)).toHaveLength(3072);
  });
});

describe("cosineSimilarity", () => {
  it("scores identical direction as 1", () => {
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 6);
  });

  it("scores orthogonal vectors as 0", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });

  it("scores opposite vectors as -1", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 6);
  });

  it("never returns NaN for zero vectors", () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
  });

  it("returns 0 when dimensionalities disagree (never a fake score)", () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });
});
