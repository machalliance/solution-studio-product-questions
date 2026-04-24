// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGenerateText, mockRetrieveChunks } = vi.hoisted(() => ({
  mockGenerateText: vi.fn(),
  mockRetrieveChunks: vi.fn(),
}));

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateText: mockGenerateText,
  };
});

vi.mock("../retrieval", () => ({
  retrieveChunks: mockRetrieveChunks,
}));

import {
  generateCandidates,
  generateSeedQuestions,
  validateAnswerability,
} from "./generate";
import type { ProductData } from "../product/types";
import type { SimilarityResult } from "../db/vectors";

function product(): ProductData {
  return {
    id: "test-product",
    name: "Test Product",
    brand: "TestBrand",
    model: "T1",
    price: 100,
    currency: "USD",
    description: "A product for tests.",
    features: ["feature a", "feature b"],
    specifications: {},
    images: [],
    category: "test",
  };
}

function chunk(text: string, i: number): SimilarityResult {
  return {
    id: `chunk-${i}`,
    text,
    score: 0.9,
    context: "Situating context",
    metadata: {
      sectionHeader: "Section",
      pageNumbers: [1],
      chunkIndex: i,
    },
  } as unknown as SimilarityResult;
}

describe("generateCandidates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends the full document with ephemeral cacheControl and no chunk list", async () => {
    mockGenerateText.mockResolvedValue({
      output: [{ question: "Q1?" }, { question: "Q2?" }],
    });

    const markdown =
      "## Full Manual\n\nDistinctive sentinel phrase: battery lasts 180 minutes.";
    const chunkText = "UNIQUE_CHUNK_STRING_THAT_SHOULD_NOT_APPEAR";

    await generateCandidates(product(), markdown, 2);

    expect(mockGenerateText).toHaveBeenCalledOnce();
    const call = mockGenerateText.mock.calls[0][0];

    // messages-shape request (not the legacy string prompt)
    expect(call.prompt).toBeUndefined();
    expect(Array.isArray(call.messages)).toBe(true);
    const userContent = call.messages[0].content;

    // First part: <document> block with full markdown + ephemeral cache.
    expect(userContent[0].type).toBe("text");
    expect(userContent[0].text).toContain("<document>");
    expect(userContent[0].text).toContain(
      "Distinctive sentinel phrase: battery lasts 180 minutes.",
    );
    expect(userContent[0].providerOptions).toEqual({
      anthropic: { cacheControl: { type: "ephemeral" } },
    });

    // Second part: instructions with product context, no cache.
    expect(userContent[1].type).toBe("text");
    expect(userContent[1].text).toContain("Test Product");
    expect(userContent[1].text).toContain("Generate exactly 2");
    expect(userContent[1].providerOptions).toBeUndefined();

    // The retrieved-chunks prompt scaffolding is gone — generator no longer
    // sees chunk text at all.
    const serialized = JSON.stringify(call);
    expect(serialized).not.toContain(chunkText);
    expect(serialized).not.toContain("[Chunk 1]");
    expect(serialized).not.toContain("Representative content from");
  });

  it("returns the question strings from the structured output", async () => {
    mockGenerateText.mockResolvedValue({
      output: [{ question: "How do I clean it?" }, { question: "Battery?" }],
    });

    const result = await generateCandidates(product(), "doc", 2);
    expect(result).toEqual(["How do I clean it?", "Battery?"]);
  });

  it("throws when the model returns no output", async () => {
    mockGenerateText.mockResolvedValue({ output: undefined });
    await expect(generateCandidates(product(), "doc", 3)).rejects.toThrow(
      /failed to generate/i,
    );
  });
});

describe("validateAnswerability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the verdict and passes a single candidate + chunk context to the model", async () => {
    mockGenerateText.mockResolvedValue({
      output: {
        answerable: true,
        groundingQuote: "The robot fully charges in 4 hours.",
        reason: "charging time is stated directly",
      },
    });

    const verdict = await validateAnswerability("How long to charge?", [
      chunk("The robot fully charges in 4 hours.", 0),
    ]);

    expect(verdict).toEqual({
      answerable: true,
      reason: "charging time is stated directly",
    });

    const call = mockGenerateText.mock.calls[0][0];
    expect(call.prompt).toContain("How long to charge?");
    expect(call.prompt).toContain("The robot fully charges in 4 hours.");
  });

  it("rejects answerable verdicts that come with no grounding quote", async () => {
    mockGenerateText.mockResolvedValue({
      output: {
        answerable: true,
        groundingQuote: "   ",
        reason: "topic is mentioned",
      },
    });

    const verdict = await validateAnswerability("Does it avoid carpets?", [
      chunk("* Carpet Sensor", 0),
    ]);

    expect(verdict.answerable).toBe(false);
    expect(verdict.reason).toMatch(/no grounding quote/i);
  });

  it("passes through not-answerable verdicts unchanged", async () => {
    mockGenerateText.mockResolvedValue({
      output: {
        answerable: false,
        groundingQuote: "",
        reason: "only appears in parts list",
      },
    });

    const verdict = await validateAnswerability("Does it avoid carpets?", [
      chunk("* Carpet Sensor", 0),
    ]);

    expect(verdict).toEqual({
      answerable: false,
      reason: "only appears in parts list",
    });
  });
});

describe("generateSeedQuestions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs per-candidate retrieval and drops candidates the validator rejects", async () => {
    mockGenerateText
      // generator
      .mockResolvedValueOnce({
        output: [{ question: "Q0?" }, { question: "Q1?" }],
      })
      // validator for Q0
      .mockResolvedValueOnce({
        output: {
          answerable: true,
          groundingQuote: "Quoted sentence for Q0.",
          reason: "grounded",
        },
      })
      // validator for Q1
      .mockResolvedValueOnce({
        output: {
          answerable: false,
          groundingQuote: "",
          reason: "only a spec-list mention",
        },
      });

    mockRetrieveChunks
      .mockResolvedValueOnce([chunk("chunk for Q0", 0)])
      .mockResolvedValueOnce([chunk("chunk for Q1", 1)]);

    const result = await generateSeedQuestions(
      product(),
      "## Manual\n\nFull document body.",
      2,
    );

    // Generator saw the document, not chunks.
    const genCall = mockGenerateText.mock.calls[0][0];
    expect(genCall.messages[0].content[0].text).toContain("Full document body");

    // Validator was called once per candidate, each with its own retrieval.
    expect(mockRetrieveChunks).toHaveBeenCalledTimes(2);
    expect(mockRetrieveChunks).toHaveBeenNthCalledWith(1, "Q0?", {
      productId: "test-product",
    });
    expect(mockRetrieveChunks).toHaveBeenNthCalledWith(2, "Q1?", {
      productId: "test-product",
    });

    // Only the answerable candidate survives.
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("Q0?");
    expect(result[0].productId).toBe("test-product");
  });

  it("rejects candidates when runtime retrieval returns nothing", async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: [{ question: "Q0?" }],
    });
    mockRetrieveChunks.mockResolvedValueOnce([]);

    const result = await generateSeedQuestions(product(), "doc", 1);

    expect(result).toHaveLength(0);
    // Validator was never called — no chunks means no grounding to judge.
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
  });
});
