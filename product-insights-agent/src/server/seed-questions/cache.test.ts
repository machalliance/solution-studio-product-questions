import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFindOne = vi.fn();
const mockReplaceOne = vi.fn();
const mockDeleteMany = vi.fn();
const mockCollection = {
  findOne: mockFindOne,
  replaceOne: mockReplaceOne,
  deleteMany: mockDeleteMany,
};
const mockDb = {
  collection: vi.fn().mockReturnValue(mockCollection),
};

import { readCache, writeCache, clearCache, createSeedQuestion } from "./cache";
import type { SeedQuestion } from "./types";
import type { Db } from "mongodb";

const db = mockDb as unknown as Db;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("readCache", () => {
  it("returns questions when cache exists", async () => {
    const questions: SeedQuestion[] = [
      {
        id: "q1",
        text: "What is the suction power?",
        productId: "dreame-x40-ultra",
        createdAt: new Date(),
      },
    ];

    mockFindOne.mockResolvedValueOnce({
      productId: "dreame-x40-ultra",
      questions,
      createdAt: new Date(),
    });

    const result = await readCache(db, "dreame-x40-ultra");
    expect(result).toEqual(questions);
    expect(mockFindOne).toHaveBeenCalledWith({ productId: "dreame-x40-ultra" });
  });

  it("returns null when no cache exists", async () => {
    mockFindOne.mockResolvedValueOnce(null);

    const result = await readCache(db, "dreame-x40-ultra");
    expect(result).toBeNull();
  });
});

describe("writeCache", () => {
  it("upserts cache entry for a product with no expiration", async () => {
    mockReplaceOne.mockResolvedValueOnce({ acknowledged: true });

    const questions: SeedQuestion[] = [
      {
        id: "q1",
        text: "What is the suction power?",
        productId: "dreame-x40-ultra",
        createdAt: new Date(),
      },
    ];

    await writeCache(db, "dreame-x40-ultra", questions);

    expect(mockReplaceOne).toHaveBeenCalledWith(
      { productId: "dreame-x40-ultra" },
      expect.objectContaining({
        productId: "dreame-x40-ultra",
        questions,
        createdAt: expect.any(Date),
      }),
      { upsert: true },
    );

    const callArgs = mockReplaceOne.mock.calls[0][1];
    expect(callArgs).not.toHaveProperty("expiresAt");
  });
});

describe("readCache error handling", () => {
  it("propagates MongoDB errors so callers can fall back to defaults", async () => {
    mockFindOne.mockRejectedValueOnce(new Error("Connection reset by peer"));
    await expect(readCache(db, "dreame-x40-ultra")).rejects.toThrow(
      "Connection reset by peer",
    );
  });

  it("returns the stored questions verbatim even if they arrive in an unexpected shape", async () => {
    // A previous writer may have stored extra fields. readCache must not
    // silently drop or rewrite them — the caller decides how to handle shape.
    mockFindOne.mockResolvedValueOnce({
      productId: "dreame-x40-ultra",
      questions: [{ id: "q1", text: "ok", productId: "dreame-x40-ultra" }],
      unexpected: "field",
    });
    const result = await readCache(db, "dreame-x40-ultra");
    expect(result).toEqual([
      { id: "q1", text: "ok", productId: "dreame-x40-ultra" },
    ]);
  });
});

describe("writeCache error handling", () => {
  it("propagates the MongoDB rejection so the caller can react", async () => {
    mockReplaceOne.mockRejectedValueOnce(new Error("E11000 duplicate key"));
    await expect(writeCache(db, "dreame-x40-ultra", [])).rejects.toThrow(
      "E11000",
    );
  });
});

describe("clearCache", () => {
  it("deletes all cache entries for a given productId", async () => {
    mockDeleteMany.mockResolvedValueOnce({ deletedCount: 1 });
    await clearCache(db, "dreame-x40-ultra");
    expect(mockDeleteMany).toHaveBeenCalledWith({
      productId: "dreame-x40-ultra",
    });
  });

  it("propagates MongoDB errors", async () => {
    mockDeleteMany.mockRejectedValueOnce(new Error("Network timeout"));
    await expect(clearCache(db, "dreame-x40-ultra")).rejects.toThrow(
      "Network timeout",
    );
  });
});

describe("createSeedQuestion", () => {
  it("creates a seed question with a UUID and timestamp", () => {
    const q = createSeedQuestion(
      "What is the suction power?",
      "dreame-x40-ultra",
    );
    expect(q.id).toBeDefined();
    expect(q.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(q.text).toBe("What is the suction power?");
    expect(q.productId).toBe("dreame-x40-ultra");
    expect(q.createdAt).toBeInstanceOf(Date);
  });

  it("generates unique IDs for different questions", () => {
    const q1 = createSeedQuestion("Question 1", "product");
    const q2 = createSeedQuestion("Question 2", "product");
    expect(q1.id).not.toBe(q2.id);
  });
});
