import { describe, it, expect } from "vitest";
import { cosineSimilarity, findBestMatches } from "../../../src/services/embeddings.js";

describe("embeddings", () => {
  it("cosineSimilarity returns 1 for identical vectors", () => {
    const v = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0);
  });

  it("cosineSimilarity returns 0 for orthogonal vectors", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0);
  });

  it("cosineSimilarity returns -1 for opposite vectors", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([-1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0);
  });

  it("findBestMatches returns top-k results sorted by similarity", () => {
    const query = new Float32Array([1, 0, 0]);
    const candidates = [
      { id: 1, embedding: new Float32Array([0, 1, 0]) },
      { id: 2, embedding: new Float32Array([1, 0, 0]) },
      { id: 3, embedding: new Float32Array([0.9, 0.1, 0]) },
    ];
    const results = findBestMatches(query, candidates, 2);
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe(2);
    expect(results[1].id).toBe(3);
  });

  it("findBestMatches handles empty candidates", () => {
    const query = new Float32Array([1, 0]);
    expect(findBestMatches(query, [], 3)).toEqual([]);
  });
});
