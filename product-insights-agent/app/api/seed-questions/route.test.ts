import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockReadCache, mockWriteCache, mockCreateSeedQuestion } = vi.hoisted(
  () => ({
    mockReadCache: vi.fn(),
    mockWriteCache: vi.fn(),
    mockCreateSeedQuestion: vi.fn((text: string, productId: string) => ({
      id: `mock-${text.slice(0, 10)}`,
      text,
      productId,
      createdAt: new Date(),
    })),
  }),
);

// Note: fs is NOT mocked. The route reads from a real tmp file created
// above via vi.hoisted + markdownCachePath indirection. Mocking `fs` builtins
// with vitest runs into resolver edge cases that aren't worth the complexity.

vi.mock("@/server/db/client", () => ({
  getDb: vi.fn().mockResolvedValue({ name: "mock-db" }),
}));

const { tmpMarkdownPath, markdownPathState } = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { mkdtempSync, writeFileSync } = require("node:fs");
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const dir = mkdtempSync(join(tmpdir(), "seed-q-test-"));
  const path = join(dir, "manual.md");
  writeFileSync(path, "# Manual\n\nSome content.");
  return {
    tmpMarkdownPath: path,
    // The route calls markdownCachePath() and then existsSync() on the
    // returned path. Flipping `useMissing` to true makes the mock point at
    // a path that does not exist, which exercises the early-return branch.
    markdownPathState: { useMissing: false },
  };
});

vi.mock("@/tooling/pipeline/extract-markdown", () => ({
  markdownCachePath: () =>
    markdownPathState.useMissing
      ? "/definitely/not/a/real/path/manual.md"
      : tmpMarkdownPath,
}));

vi.mock("@/server/seed-questions/cache", () => ({
  readCache: (...args: unknown[]) =>
    mockReadCache(...(args as [unknown, unknown])),
  writeCache: (...args: unknown[]) =>
    mockWriteCache(...(args as [unknown, unknown, unknown])),
  createSeedQuestion: (...args: unknown[]) =>
    mockCreateSeedQuestion(...(args as [string, string])),
}));

vi.mock("@/server/seed-questions/rotation", () => ({
  selectQuestions: vi.fn(
    (questions: Array<{ id: string }>, _clickedIds: string[], count: number) =>
      questions.slice(0, count),
  ),
}));

vi.mock("@/server/seed-questions/generate", () => ({
  generateSeedQuestions: vi.fn().mockResolvedValue([]),
}));

const mockGetProduct = vi.fn().mockResolvedValue({
  id: "dreame-x40-ultra",
  name: "Dreame X40 Ultra",
  brand: "Dreame",
  model: "X40 Ultra",
  price: 1899.99,
  currency: "CAD",
  description: "A robot vacuum",
  features: ["12,000Pa suction"],
  specifications: {},
  images: [],
  category: "Robot Vacuums",
});

vi.mock("@/server/product/file-adapter", () => {
  class MockFileProductDataAdapter {
    async getProduct(...args: unknown[]) {
      return mockGetProduct(...args);
    }
  }
  return { FileProductDataAdapter: MockFileProductDataAdapter };
});

vi.mock("@/server/retrieval", () => ({
  retrieveChunks: vi.fn().mockResolvedValue([]),
}));

import { GET } from "./route";
import { generateSeedQuestions } from "@/server/seed-questions/generate";

beforeEach(() => {
  vi.clearAllMocks();
  markdownPathState.useMissing = false;
});

// Helper: wait for the fire-and-forget background generation started by the
// route. The route doesn't await it, so tests that want to assert on
// generateSeedQuestions / writeCache need to flush the microtask queue.
async function flushBackground() {
  // The background generation chain has several awaits: productAdapter.getProduct()
  // → existsSync / readFileSync → generateSeedQuestions → getDb → writeCache.
  // Flush enough microtasks for the chain to complete under fully-resolved mocks.
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

function makeRequest(queryParams = ""): Request {
  return new Request(`http://localhost:3000/api/seed-questions${queryParams}`);
}

describe("GET /api/seed-questions", () => {
  it("returns 3 questions from cache when available", async () => {
    const cachedQuestions = [
      {
        id: "q1",
        text: "Q1",
        productId: "dreame-x40-ultra",
        createdAt: new Date(),
      },
      {
        id: "q2",
        text: "Q2",
        productId: "dreame-x40-ultra",
        createdAt: new Date(),
      },
      {
        id: "q3",
        text: "Q3",
        productId: "dreame-x40-ultra",
        createdAt: new Date(),
      },
      {
        id: "q4",
        text: "Q4",
        productId: "dreame-x40-ultra",
        createdAt: new Date(),
      },
    ];
    mockReadCache.mockResolvedValueOnce(cachedQuestions);

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.questions).toHaveLength(3);
    expect(data.source).toBe("cache");
  });

  it("returns fallback questions when cache is empty", async () => {
    mockReadCache.mockResolvedValueOnce(null);

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.questions).toHaveLength(3);
    expect(data.source).toBe("fallback");
  });

  it("falls through to fallback when the cache is smaller than displayCount", async () => {
    // A prior run wrote only 1 question — treat it like a miss so the
    // route re-triggers generation instead of serving 1 pill forever.
    mockReadCache.mockResolvedValueOnce([
      {
        id: "q1",
        text: "Only one",
        productId: "dreame-x40-ultra",
        createdAt: new Date(),
      },
    ]);

    const res = await GET(makeRequest());
    const data = await res.json();
    expect(data.source).toBe("fallback");
    expect(data.questions).toHaveLength(3);
  });

  it("returns fallback questions when MongoDB is unavailable", async () => {
    mockReadCache.mockRejectedValueOnce(new Error("Connection failed"));

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.source).toBe("fallback");
  });

  it("passes clicked IDs from query params", async () => {
    const cachedQuestions = [
      {
        id: "q1",
        text: "Q1",
        productId: "dreame-x40-ultra",
        createdAt: new Date(),
      },
      {
        id: "q2",
        text: "Q2",
        productId: "dreame-x40-ultra",
        createdAt: new Date(),
      },
      {
        id: "q3",
        text: "Q3",
        productId: "dreame-x40-ultra",
        createdAt: new Date(),
      },
    ];
    mockReadCache.mockResolvedValueOnce(cachedQuestions);

    const { selectQuestions } =
      await import("@/server/seed-questions/rotation");

    const res = await GET(makeRequest("?clicked=q1,q2"));
    expect(res.status).toBe(200);

    expect(selectQuestions).toHaveBeenCalledWith(
      cachedQuestions,
      ["q1", "q2"],
      3,
    );
  });

  it("handles empty clicked param gracefully", async () => {
    mockReadCache.mockResolvedValueOnce(null);

    const res = await GET(makeRequest("?clicked="));
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.questions).toBeDefined();
  });

  it("does not invoke the generator when the manual markdown is missing", async () => {
    mockReadCache.mockResolvedValueOnce(null);
    markdownPathState.useMissing = true;

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    await flushBackground();

    expect(generateSeedQuestions).not.toHaveBeenCalled();
    expect(mockWriteCache).not.toHaveBeenCalled();
  });

  it("does not write cache when the generator returns fewer than displayCount questions", async () => {
    mockReadCache.mockResolvedValueOnce(null);
    vi.mocked(generateSeedQuestions).mockResolvedValueOnce([
      {
        id: "g1",
        text: "Partial",
        productId: "dreame-x40-ultra",
        createdAt: new Date(),
      },
    ]);

    await GET(makeRequest());
    await flushBackground();

    // generateSeedQuestions may or may not run depending on whether the
    // real-fs markdownCachePath exists in the test environment. In either
    // case, writeCache must NOT be called for a partial result.
    expect(mockWriteCache).not.toHaveBeenCalled();
  });

  it("writes cache when the generator returns at least displayCount questions", async () => {
    mockReadCache.mockResolvedValueOnce(null);
    const produced = Array.from({ length: 5 }, (_, i) => ({
      id: `g${i}`,
      text: `Q${i}`,
      productId: "dreame-x40-ultra",
      createdAt: new Date(),
    }));
    vi.mocked(generateSeedQuestions).mockResolvedValueOnce(produced);

    await GET(makeRequest());
    await flushBackground();

    expect(mockWriteCache).toHaveBeenCalledWith(
      { name: "mock-db" },
      "dreame-x40-ultra",
      produced,
    );
  });

  it("reads productId from the query param and passes it to readCache", async () => {
    mockReadCache.mockResolvedValueOnce(null);

    const res = await GET(makeRequest("?productId=other-product"));
    expect(res.status).toBe(200);

    expect(mockReadCache).toHaveBeenCalledWith(
      { name: "mock-db" },
      "other-product",
    );

    const data = await res.json();
    expect(data.productId).toBe("other-product");
    // fallback questions should be tagged with the requested productId
    for (const q of data.questions) {
      expect(q.productId).toBe("other-product");
    }
  });

  it("falls back to config default when productId is missing", async () => {
    mockReadCache.mockResolvedValueOnce(null);

    const res = await GET(makeRequest());
    const data = await res.json();

    expect(data.productId).toBe("dreame-x40-ultra");
  });

  it("returns questions with expected shape", async () => {
    const cachedQuestions = [
      {
        id: "q1",
        text: "What is the suction power?",
        productId: "dreame-x40-ultra",
        createdAt: new Date(),
      },
      {
        id: "q2",
        text: "How does the mop work?",
        productId: "dreame-x40-ultra",
        createdAt: new Date(),
      },
      {
        id: "q3",
        text: "Battery life?",
        productId: "dreame-x40-ultra",
        createdAt: new Date(),
      },
    ];
    mockReadCache.mockResolvedValueOnce(cachedQuestions);

    const res = await GET(makeRequest());
    const data = await res.json();

    for (const q of data.questions) {
      expect(q).toHaveProperty("id");
      expect(q).toHaveProperty("text");
      expect(q).toHaveProperty("productId");
    }
  });
});
