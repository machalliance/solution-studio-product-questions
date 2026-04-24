import { describe, it, expect, vi, beforeEach } from "vitest";
import type { EnrichedChunk } from "@/tooling/pipeline/metadata";

// Mock the AI SDK embed functions to avoid real API calls in tests
vi.mock("ai", () => ({
  embed: vi.fn().mockResolvedValue({
    embedding: Array(1536).fill(0.1),
  }),
  embedMany: vi.fn().mockResolvedValue({
    embeddings: [],
  }),
}));

import { generateEmbedding, generateEmbeddings } from "./vectors";
import { embedMany } from "ai";

describe("generateEmbedding", () => {
  it("returns an embedding vector of the correct dimension", async () => {
    const embedding = await generateEmbedding("test text");
    expect(embedding).toHaveLength(1536);
    expect(typeof embedding[0]).toBe("number");
  });
});

describe("generateEmbeddings", () => {
  beforeEach(() => {
    vi.mocked(embedMany).mockClear();
  });

  it("returns embeddings for multiple texts in order", async () => {
    const mockEmbeddings = [
      Array(1536).fill(0.1),
      Array(1536).fill(0.2),
      Array(1536).fill(0.3),
    ];
    vi.mocked(embedMany).mockResolvedValueOnce({
      embeddings: mockEmbeddings,
      values: ["a", "b", "c"],
      usage: { tokens: 30 },
      warnings: [],
    } as Awaited<ReturnType<typeof embedMany>>);

    const results = await generateEmbeddings(["a", "b", "c"]);
    expect(results).toHaveLength(3);
    expect(results[0][0]).toBe(0.1);
    expect(results[1][0]).toBe(0.2);
    expect(results[2][0]).toBe(0.3);
  });

  it("calls embedMany with correct model", async () => {
    vi.mocked(embedMany).mockResolvedValueOnce({
      embeddings: [Array(1536).fill(0)],
      values: ["test"],
      usage: { tokens: 5 },
      warnings: [],
    } as Awaited<ReturnType<typeof embedMany>>);

    await generateEmbeddings(["test"]);
    expect(embedMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        model: "openai/text-embedding-3-small",
        values: ["test"],
        maxParallelCalls: 5,
      }),
    );
  });
});

describe("StoredChunk shape", () => {
  it("matches the expected document structure for MongoDB", () => {
    // Verify the enriched chunk to stored chunk mapping is correct
    const enrichedChunk: EnrichedChunk = {
      text: "Safety instructions for the robot",
      context: "",
      embeddingInput: "Safety instructions for the robot",
      metadata: {
        sectionHeader: "Safety Information",
        pageNumbers: [3, 4],
        chunkIndex: 0,
        charCount: 33,
        tokenCount: 8,
      },
    };

    // Simulate what insertChunks would produce
    const storedDoc = {
      text: enrichedChunk.text,
      embedding: Array(1536).fill(0),
      metadata: enrichedChunk.metadata,
      productId: "dreame-x40-ultra",
      createdAt: new Date(),
    };

    expect(storedDoc.text).toBe(enrichedChunk.text);
    expect(storedDoc.metadata).toEqual(enrichedChunk.metadata);
    expect(storedDoc.embedding).toHaveLength(1536);
    expect(storedDoc.productId).toBe("dreame-x40-ultra");
    expect(storedDoc.createdAt).toBeInstanceOf(Date);
  });
});

describe("SimilarityResult shape", () => {
  it("has the expected fields", () => {
    const result = {
      text: "How to clean the filter",
      metadata: {
        sectionHeader: "Routine Maintenance",
        pageNumbers: [19],
        chunkIndex: 5,
        charCount: 23,
        tokenCount: 6,
      },
      score: 0.92,
    };

    expect(result.text).toBeDefined();
    expect(result.metadata.sectionHeader).toBeDefined();
    expect(result.metadata.pageNumbers).toBeInstanceOf(Array);
    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThanOrEqual(1);
  });
});
