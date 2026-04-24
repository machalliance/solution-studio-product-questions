import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock db client and vectors modules
vi.mock("./db/client", () => ({
  getDb: vi.fn().mockResolvedValue({ name: "mock-db" }),
}));

vi.mock("./db/vectors", () => ({
  similaritySearch: vi.fn().mockResolvedValue([]),
}));

import { retrieveChunks } from "./retrieval";
import { similaritySearch } from "./db/vectors";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("retrieveChunks", () => {
  it("calls similaritySearch with the correct query and default options", async () => {
    await retrieveChunks("How does the mop work?");

    expect(similaritySearch).toHaveBeenCalledWith(
      { name: "mock-db" },
      "How does the mop work?",
      {
        productId: "dreame-x40-ultra",
        topK: 5,
        minScore: 0.5,
      },
    );
  });

  it("passes custom options to similaritySearch", async () => {
    await retrieveChunks("suction power", {
      productId: "custom-product",
      topK: 3,
      minScore: 0.7,
    });

    expect(similaritySearch).toHaveBeenCalledWith(
      { name: "mock-db" },
      "suction power",
      {
        productId: "custom-product",
        topK: 3,
        minScore: 0.7,
      },
    );
  });

  it("returns chunks sorted by relevance score", async () => {
    const mockResults = [
      {
        text: "Chunk A",
        metadata: {
          sectionHeader: "Usage",
          pageNumbers: [5],
          chunkIndex: 0,
          charCount: 7,
          tokenCount: 2,
        },
        score: 0.95,
      },
      {
        text: "Chunk B",
        metadata: {
          sectionHeader: "Setup",
          pageNumbers: [2],
          chunkIndex: 1,
          charCount: 7,
          tokenCount: 2,
        },
        score: 0.82,
      },
    ];

    vi.mocked(similaritySearch).mockResolvedValueOnce(mockResults);

    const results = await retrieveChunks("test query");
    expect(results).toHaveLength(2);
    expect(results[0].score).toBe(0.95);
    expect(results[1].score).toBe(0.82);
  });

  it("handles zero results gracefully", async () => {
    vi.mocked(similaritySearch).mockResolvedValueOnce([]);

    const results = await retrieveChunks("completely unrelated query");
    expect(results).toHaveLength(0);
    expect(results).toEqual([]);
  });

  it("returns results untouched — retrieveChunks does not post-filter by score", async () => {
    // `retrieveChunks` is a thin passthrough. If a caller ever adds a local
    // score filter here, retrieval would silently drop low-score results that
    // similaritySearch (authoritative) already accepted. Lock that in.
    const raw = [
      {
        text: "low-score chunk kept by the store",
        context: "",
        metadata: {
          sectionHeader: "Notes",
          pageNumbers: [],
          chunkIndex: 0,
          charCount: 10,
          tokenCount: 2,
        },
        score: 0.15, // well below the default minScore of 0.5
      },
    ];
    vi.mocked(similaritySearch).mockResolvedValueOnce(raw);

    const results = await retrieveChunks("q");
    expect(results).toEqual(raw);
    expect(results[0].score).toBe(0.15);
  });
});
