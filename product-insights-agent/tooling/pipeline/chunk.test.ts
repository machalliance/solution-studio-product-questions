import { describe, it, expect } from "vitest";
import { chunkMarkdown, DEFAULT_CHUNK_CONFIG, type ChunkConfig } from "./chunk";
import { countTokens } from "./tokens";

describe("chunkMarkdown", () => {
  it("splits on Markdown headings into sections", () => {
    const markdown = [
      "## Safety Information",
      "Keep away from water. " + "This is important safety content. ".repeat(5),
      "",
      "## How to Use",
      "Press the power button. " +
        "Follow the instructions carefully. ".repeat(5),
    ].join("\n");

    const chunks = chunkMarkdown(markdown);

    // With the small-section merge behavior, tiny adjacent sections may combine.
    // What matters is that the content from both sections survives.
    const combined = chunks.map((c) => c.text).join("\n");
    expect(combined).toContain("Keep away from water");
    expect(combined).toContain("Press the power button");

    const headings = chunks.map((c) => c.sectionHeader).join(" ");
    expect(headings).toContain("Safety Information");
    expect(headings).toContain("How to Use");
  });

  it("sub-splits large sections that exceed chunk size (tokens)", () => {
    const markdown =
      "## Large Section\n\n" +
      "Paragraph one. ".repeat(200) +
      "\n\n" +
      "Paragraph two. ".repeat(200);

    const config: ChunkConfig = {
      ...DEFAULT_CHUNK_CONFIG,
      chunkSize: 128, // tokens
      overlap: 10,
    };

    const chunks = chunkMarkdown(markdown, config);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.sectionHeader).toContain("Large Section");
    }
  });

  it("merges small adjacent sections rather than dropping them", () => {
    // Regression: previously a section with content shorter than `minChunkSize`
    // (characters) was silently skipped, losing content like "* Robot\n* Base Station"
    // when Gemini re-extracted the document with different heading structure.
    const markdown = [
      "## Package Contents",
      "* Robot",
      "* Base Station",
      "",
      "## Other Accessories",
      "* Power Cord",
      "* User Manual",
      "* Base Station Ramp Extension Plate",
      "* Auto-Detergent Compartment (pre-installed)",
      "* Mop Pad × 2 (pre-installed)",
      "* Mop Pad Holder × 2",
      "* Dust Bag × 2 (1 pre-installed)",
      "* Cleaning Tool",
      "* Cleaning Solution",
    ].join("\n");

    const chunks = chunkMarkdown(markdown);
    const allText = chunks.map((c) => c.text).join("\n");

    // The "Robot" and "Base Station" items must survive — they're the exact
    // items the previous implementation dropped on small sections.
    expect(allText).toContain("Robot");
    expect(allText).toContain("Base Station");
    expect(allText).toContain("Power Cord");
    expect(allText).toContain("Cleaning Solution");
  });

  it("propagates heading metadata to all sub-chunks", () => {
    const markdown = "## Maintenance Guide\n\n" + "Step details. ".repeat(300);

    const config: ChunkConfig = {
      ...DEFAULT_CHUNK_CONFIG,
      chunkSize: 128, // tokens
      overlap: 10,
    };

    const chunks = chunkMarkdown(markdown, config);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.sectionHeader).toBe("Maintenance Guide");
    }
  });

  it("handles Markdown with no headings (falls back to recursive splitting)", () => {
    const markdown = "Just plain text. ".repeat(300);

    const config: ChunkConfig = {
      ...DEFAULT_CHUNK_CONFIG,
      chunkSize: 128, // tokens
      overlap: 10,
    };

    const chunks = chunkMarkdown(markdown, config);

    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.sectionHeader).toBe("General");
    }
  });

  it("handles H1, H2, and H3 headings", () => {
    const markdown = [
      "# Top Level",
      "Top content that is long enough to meet the minimum size. ".repeat(5),
      "",
      "## Second Level",
      "Second content that is long enough to meet the minimum size. ".repeat(5),
      "",
      "### Third Level",
      "Third content that is long enough to meet the minimum size. ".repeat(5),
    ].join("\n");

    const chunks = chunkMarkdown(markdown);
    const headings = chunks.map((c) => c.sectionHeader).join(" ");

    expect(headings).toContain("Top Level");
    expect(headings).toContain("Second Level");
    expect(headings).toContain("Third Level");
  });

  it("respects overlap between chunks", () => {
    const markdown =
      "## Content\n\n" +
      "First section of text. " +
      "Middle section of text. ".repeat(200) +
      "Last section of text.";

    const config: ChunkConfig = {
      ...DEFAULT_CHUNK_CONFIG,
      chunkSize: 128, // tokens
      overlap: 30, // tokens (~25% overlap)
    };

    const chunks = chunkMarkdown(markdown, config);
    if (chunks.length > 1) {
      for (let i = 0; i < chunks.length - 1; i++) {
        const endOfCurrent = chunks[i].text.slice(-80);
        const startOfNext = chunks[i + 1].text.slice(0, 300);
        const overlap = endOfCurrent
          .split(" ")
          .some((word) => word.length > 3 && startOfNext.includes(word));
        expect(overlap).toBe(true);
      }
    }
  });

  it("indexes chunks sequentially", () => {
    const markdown = [
      "## Section A",
      "Content A. ".repeat(50),
      "",
      "## Section B",
      "Content B. ".repeat(50),
    ].join("\n");

    const chunks = chunkMarkdown(markdown);
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].index).toBe(i);
    }
  });

  it("handles empty input", () => {
    expect(chunkMarkdown("")).toEqual([]);
  });

  it("preserves section boundaries for long non-trivial sections", () => {
    // Sections long enough to exceed chunkSize stay separated — the merge
    // logic only folds together sections too small to stand alone.
    const markdown = [
      "## Safety Rules",
      "Safety content here. ".repeat(300),
      "",
      "## Usage Guide",
      "Usage content here. ".repeat(300),
    ].join("\n");

    const chunks = chunkMarkdown(markdown);
    const safetyChunks = chunks.filter((c) =>
      c.sectionHeader.includes("Safety Rules"),
    );
    const usageChunks = chunks.filter((c) =>
      c.sectionHeader.includes("Usage Guide"),
    );

    expect(safetyChunks.length).toBeGreaterThan(0);
    expect(usageChunks.length).toBeGreaterThan(0);
  });

  it("produces chunks within the expected token band for default config", () => {
    const markdown =
      "## Long Section\n\n" +
      "This is a sentence with meaningful content. ".repeat(400);

    const chunks = chunkMarkdown(markdown);
    for (const chunk of chunks) {
      const tokens = countTokens(chunk.text);
      // Splitter allows up to 1.2x overflow plus some heading merge room.
      expect(tokens).toBeLessThanOrEqual(
        Math.ceil(DEFAULT_CHUNK_CONFIG.chunkSize * 1.5),
      );
    }
  });
});
