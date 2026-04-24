import { describe, it, expect } from "vitest";
import { countTokens, truncateToTokens } from "./tokens";

describe("countTokens", () => {
  it("returns 0 for empty input", () => {
    expect(countTokens("")).toBe(0);
  });

  it("counts tokens in short English prose", () => {
    const tokens = countTokens("The robot vacuum cleans the floor.");
    expect(tokens).toBeGreaterThan(5);
    expect(tokens).toBeLessThan(15);
  });

  it("produces a stable, deterministic count for the same input", () => {
    const text = "Section heading followed by paragraph text.";
    expect(countTokens(text)).toBe(countTokens(text));
  });

  it("counts fewer tokens than characters for English prose", () => {
    const text = "The quick brown fox jumps over the lazy dog. ".repeat(20);
    const tokens = countTokens(text);
    expect(tokens).toBeLessThan(text.length);
  });

  it("handles Markdown tables without crashing", () => {
    const table = [
      "| Column A | Column B |",
      "|----------|----------|",
      "| Cell 1   | Cell 2   |",
      "| Cell 3   | Cell 4   |",
    ].join("\n");
    expect(countTokens(table)).toBeGreaterThan(0);
  });

  it("handles multilingual input (CJK + Latin)", () => {
    const mixed = "Hello 世界 — bonjour le monde";
    expect(countTokens(mixed)).toBeGreaterThan(0);
  });
});

describe("truncateToTokens", () => {
  it("returns the original text when already under the limit", () => {
    const text = "Short text.";
    expect(truncateToTokens(text, 100)).toBe(text);
  });

  it("truncates long text to approximately the token limit", () => {
    const text = "one two three four five six seven eight nine ten ".repeat(50);
    const truncated = truncateToTokens(text, 10);
    expect(countTokens(truncated)).toBeLessThanOrEqual(10);
    expect(truncated.length).toBeLessThan(text.length);
  });

  it("handles zero limit", () => {
    expect(truncateToTokens("anything here", 0)).toBe("");
  });
});
