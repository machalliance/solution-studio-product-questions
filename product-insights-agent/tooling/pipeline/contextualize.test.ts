// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGenerateText } = vi.hoisted(() => ({
  mockGenerateText: vi.fn(),
}));

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateText: mockGenerateText,
  };
});

import { generateChunkContexts } from "./contextualize";
import type { RawChunk } from "./chunk";

function makeChunk(text: string, index: number): RawChunk {
  return {
    text,
    pageNumbers: [],
    sectionHeader: "Test Section",
    index,
  };
}

describe("generateChunkContexts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty array for empty input", async () => {
    const result = await generateChunkContexts("doc", []);
    expect(result).toEqual([]);
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("returns one context per chunk in the same order", async () => {
    mockGenerateText
      .mockResolvedValueOnce({ text: "Context for chunk A." })
      .mockResolvedValueOnce({ text: "Context for chunk B." })
      .mockResolvedValueOnce({ text: "Context for chunk C." });

    const result = await generateChunkContexts(
      "## Doc\n\nBody.",
      [
        makeChunk("Chunk A body", 0),
        makeChunk("Chunk B body", 1),
        makeChunk("Chunk C body", 2),
      ],
      { maxParallel: 1 }, // serialize so the mock ordering is stable
    );

    expect(result).toEqual([
      "Context for chunk A.",
      "Context for chunk B.",
      "Context for chunk C.",
    ]);
    expect(mockGenerateText).toHaveBeenCalledTimes(3);
  });

  it("includes the document and chunk in the prompt with cacheControl on the document", async () => {
    mockGenerateText.mockResolvedValue({ text: "ctx." });

    await generateChunkContexts("## Full Doc\n\nEntire markdown content.", [
      makeChunk("Just this chunk", 0),
    ]);

    expect(mockGenerateText).toHaveBeenCalledOnce();
    const call = mockGenerateText.mock.calls[0][0];
    const userContent = call.messages[0].content;

    // Document part carries cacheControl so Anthropic caches the prefix.
    expect(userContent[0].text).toContain("<document>");
    expect(userContent[0].text).toContain("Entire markdown content");
    expect(userContent[0].providerOptions).toEqual({
      anthropic: { cacheControl: { type: "ephemeral" } },
    });

    // Chunk part carries the actual question + no cache (per-request content).
    expect(userContent[1].text).toContain("<chunk>");
    expect(userContent[1].text).toContain("Just this chunk");
    expect(userContent[1].providerOptions).toBeUndefined();
  });

  it("trims whitespace from the returned context", async () => {
    mockGenerateText.mockResolvedValue({
      text: "   Leading and trailing whitespace.   \n",
    });

    const result = await generateChunkContexts("doc", [makeChunk("chunk", 0)]);

    expect(result[0]).toBe("Leading and trailing whitespace.");
  });

  it("returns empty string for a chunk when the model keeps failing", async () => {
    mockGenerateText.mockRejectedValue(new Error("rate limited"));

    const result = await generateChunkContexts("doc", [makeChunk("chunk", 0)], {
      maxParallel: 1,
    });

    expect(result).toEqual([""]);
  });

  it("continues when one chunk fails but others succeed", async () => {
    mockGenerateText
      .mockResolvedValueOnce({ text: "ok1" })
      .mockRejectedValueOnce(new Error("fail"))
      .mockRejectedValueOnce(new Error("fail"))
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValueOnce({ text: "ok3" });

    const result = await generateChunkContexts(
      "doc",
      [makeChunk("A", 0), makeChunk("B", 1), makeChunk("C", 2)],
      { maxParallel: 1 },
    );

    expect(result[0]).toBe("ok1");
    expect(result[1]).toBe("");
    expect(result[2]).toBe("ok3");
  });

  it("reports progress via onProgress callback", async () => {
    mockGenerateText.mockResolvedValue({ text: "ctx" });

    const progressCalls: Array<[number, number]> = [];
    await generateChunkContexts("doc", [makeChunk("A", 0), makeChunk("B", 1)], {
      maxParallel: 1,
      onProgress: (done, total) => progressCalls.push([done, total]),
    });

    expect(progressCalls).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });
});
