import { describe, it, expect } from "vitest";
import { enrichChunks, applyChunkContexts } from "./metadata";
import type { RawChunk } from "./chunk";
import { countTokens } from "./tokens";

describe("enrichChunks", () => {
  it("enriches chunks with correct metadata shape", () => {
    const raw: RawChunk[] = [
      {
        text: "Safety instructions for the product.",
        pageNumbers: [],
        sectionHeader: "Safety Information",
        index: 0,
      },
      {
        text: "How to set up the device and connect to WiFi.",
        pageNumbers: [],
        sectionHeader: "Getting Started",
        index: 1,
      },
    ];

    const enriched = enrichChunks(raw);

    expect(enriched).toHaveLength(2);

    expect(enriched[0].metadata).toEqual({
      sectionHeader: "Safety Information",
      pageNumbers: [],
      chunkIndex: 0,
      charCount: raw[0].text.length,
      tokenCount: countTokens(raw[0].text),
    });

    expect(enriched[1].metadata).toEqual({
      sectionHeader: "Getting Started",
      pageNumbers: [],
      chunkIndex: 1,
      charCount: raw[1].text.length,
      tokenCount: countTokens(raw[1].text),
    });

    // Contextual Retrieval scaffolding: context starts empty, embeddingInput
    // mirrors the raw text until the contextualize step fills it in.
    expect(enriched[0].context).toBe("");
    expect(enriched[0].embeddingInput).toBe(raw[0].text);
    expect(enriched[1].context).toBe("");
    expect(enriched[1].embeddingInput).toBe(raw[1].text);
  });

  it("preserves original text in enriched chunks", () => {
    const raw: RawChunk[] = [
      {
        text: "Original text content here.",
        pageNumbers: [],
        sectionHeader: "How to Use",
        index: 0,
      },
    ];

    const enriched = enrichChunks(raw);
    expect(enriched[0].text).toBe("Original text content here.");
  });

  it("handles empty input", () => {
    expect(enrichChunks([])).toEqual([]);
  });
});

describe("applyChunkContexts", () => {
  const raw: RawChunk[] = [
    {
      text: "Original chunk body.",
      pageNumbers: [1],
      sectionHeader: "Safety Information",
      index: 0,
    },
    {
      text: "Another chunk body.",
      pageNumbers: [2],
      sectionHeader: "Getting Started",
      index: 1,
    },
  ];

  it("prepends context to embeddingInput and preserves text", () => {
    const enriched = enrichChunks(raw);
    const withContext = applyChunkContexts(enriched, [
      "This section describes product safety.",
      "This section covers initial setup.",
    ]);

    expect(withContext[0].text).toBe("Original chunk body.");
    expect(withContext[0].context).toBe(
      "This section describes product safety.",
    );
    expect(withContext[0].embeddingInput).toBe(
      "This section describes product safety.\n\nOriginal chunk body.",
    );

    expect(withContext[1].embeddingInput).toBe(
      "This section covers initial setup.\n\nAnother chunk body.",
    );
  });

  it("leaves chunks unchanged when context is empty string", () => {
    const enriched = enrichChunks(raw);
    const withContext = applyChunkContexts(enriched, ["", "   "]);

    expect(withContext[0].context).toBe("");
    expect(withContext[0].embeddingInput).toBe("Original chunk body.");
    expect(withContext[1].context).toBe("");
    expect(withContext[1].embeddingInput).toBe("Another chunk body.");
  });

  it("throws when context and chunk array lengths mismatch", () => {
    const enriched = enrichChunks(raw);
    expect(() => applyChunkContexts(enriched, ["only one"])).toThrow(/length/i);
  });
});
