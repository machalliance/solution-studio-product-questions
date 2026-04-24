import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from "fs";
import { resolve } from "path";
import type { EvalSet } from "./eval-set";
import { loadEvalSet, saveEvalSet, evalSetPath } from "./eval-set";

const SAMPLE_EVAL_SET: EvalSet = {
  productId: "test-eval-set-product",
  generatedAt: "2025-01-01T00:00:00.000Z",
  model: "anthropic/claude-sonnet-4-5",
  items: [
    {
      question: "What is the suction power?",
      answer: "The suction power is 12000Pa.",
      sourcePassage: "Maximum suction power: 12000Pa",
      topic: "specifications",
      claims: ["The suction power is 12000Pa"],
      relevantSections: ["Specifications"],
    },
    {
      question: "How do I clean the filter?",
      answer:
        "Remove the filter and rinse under running water. Let it dry completely before reinstalling.",
      sourcePassage:
        "Remove the filter module and rinse under running water. Allow to dry for at least 24 hours.",
      topic: "maintenance",
      claims: [
        "The filter should be removed for cleaning",
        "The filter should be rinsed under running water",
        "The filter must dry completely before reinstalling",
      ],
      relevantSections: ["Maintenance", "Filter Care"],
    },
  ],
};

// Clean up test files after each test
afterEach(() => {
  const testPath = evalSetPath("test-eval-set-product");
  if (existsSync(testPath)) {
    rmSync(testPath);
  }
});

describe("evalSetPath", () => {
  it("returns a path containing the product ID", () => {
    const path = evalSetPath("test-product");
    expect(path).toContain("test-product.json");
    expect(path).toContain("eval-sets");
  });

  it("returns different paths for different product IDs", () => {
    const path1 = evalSetPath("product-a");
    const path2 = evalSetPath("product-b");
    expect(path1).not.toBe(path2);
  });
});

describe("loadEvalSet", () => {
  it("returns null when no cache file exists", () => {
    const result = loadEvalSet("nonexistent-product-xyz");
    expect(result).toBeNull();
  });

  it("reads and parses cached eval set from disk", () => {
    // Write a real file to disk
    saveEvalSet(SAMPLE_EVAL_SET);

    const result = loadEvalSet("test-eval-set-product");
    expect(result).not.toBeNull();
    expect(result!.productId).toBe("test-eval-set-product");
    expect(result!.items).toHaveLength(2);
    expect(result!.items[0].question).toBe("What is the suction power?");
  });

  it("returns expected shape with all required fields", () => {
    saveEvalSet(SAMPLE_EVAL_SET);

    const result = loadEvalSet("test-eval-set-product");
    expect(result).toHaveProperty("productId");
    expect(result).toHaveProperty("generatedAt");
    expect(result).toHaveProperty("model");
    expect(result).toHaveProperty("items");

    const item = result!.items[0];
    expect(item).toHaveProperty("question");
    expect(item).toHaveProperty("answer");
    expect(item).toHaveProperty("sourcePassage");
    expect(item).toHaveProperty("topic");
  });

  it("returns null on corrupt JSON without crashing", () => {
    // Write corrupt JSON to the expected path
    const path = evalSetPath("test-eval-set-product");
    const dir = resolve(path, "..");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(path, "not valid json{{{", "utf-8");

    const result = loadEvalSet("test-eval-set-product");
    expect(result).toBeNull();
  });
});

describe("saveEvalSet", () => {
  it("writes eval set to the correct path", () => {
    saveEvalSet(SAMPLE_EVAL_SET);

    const path = evalSetPath("test-eval-set-product");
    expect(existsSync(path)).toBe(true);
  });

  it("writes valid JSON that can be parsed back", () => {
    saveEvalSet(SAMPLE_EVAL_SET);

    const path = evalSetPath("test-eval-set-product");
    const content = readFileSync(path, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.productId).toBe("test-eval-set-product");
    expect(parsed.items).toHaveLength(2);
  });

  it("creates directory if it does not exist", () => {
    // If we can save without error, directory creation worked
    saveEvalSet(SAMPLE_EVAL_SET);
    const path = evalSetPath("test-eval-set-product");
    expect(existsSync(path)).toBe(true);
  });
});
