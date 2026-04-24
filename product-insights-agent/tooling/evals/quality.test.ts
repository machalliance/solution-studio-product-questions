import { describe, it, expect, vi, afterAll, beforeEach } from "vitest";

// Mock all external dependencies to test the runner infrastructure
vi.mock("../pipeline/extract-markdown", () => ({
  extractToMarkdown: vi.fn().mockResolvedValue({
    markdown: "## Safety Information\n\nDo not use in wet areas",
    cached: true,
  }),
}));

vi.mock("../pipeline/eval-set", () => ({
  getOrGenerateEvalSet: vi.fn().mockResolvedValue({
    productId: "dreame-x40-ultra",
    generatedAt: "2025-01-01T00:00:00.000Z",
    model: "anthropic/claude-sonnet-4-5",
    items: [
      {
        question: "Is it safe to use in wet areas?",
        answer: "No, do not use in wet areas.",
        sourcePassage: "Do not use in wet areas",
        topic: "safety",
      },
      {
        question: "What are all the cleaning modes?",
        answer:
          "The vacuum has multiple cleaning modes including auto and manual.",
        sourcePassage: "Cleaning modes include auto, manual, and spot cleaning",
        topic: "usage",
      },
    ],
  }),
}));

vi.mock("@/server/retrieval", () => ({
  retrieveChunks: vi.fn().mockResolvedValue([
    {
      text: "Do not use in wet areas. Safety warning.",
      metadata: {
        sectionHeader: "Safety",
        pageNumbers: [1],
        chunkIndex: 0,
        charCount: 40,
        tokenCount: 10,
      },
      score: 0.92,
    },
  ]),
}));

vi.mock("@/server/product/file-adapter", () => ({
  FileProductDataAdapter: class {
    getProduct = vi.fn().mockResolvedValue({
      id: "dreame-x40-ultra",
      name: "Dreame X40 Ultra",
      brand: "Dreame",
      model: "X40 Ultra",
      price: 1899.99,
      currency: "CAD",
      category: "Robot Vacuums",
      features: ["Self-cleaning"],
      specifications: { "Suction Power": "12000Pa" },
      description: "Advanced robot vacuum",
    });
  },
}));

vi.mock("@/server/prompt", () => ({
  buildSystemPrompt: vi.fn().mockResolvedValue("You are a product assistant."),
  buildUserMessage: vi.fn().mockReturnValue("Context + question"),
}));

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateText: vi.fn().mockResolvedValue({
      text: "No, you should not use this vacuum in wet areas. The product manual explicitly warns against use in wet areas for safety reasons.",
      output: {
        grounding: { score: 0.95, reasoning: "Well grounded in source" },
        retrievalRelevance: { score: 0.9, reasoning: "Correct chunks" },
        tone: { score: 0.85, reasoning: "Professional and helpful" },
        lengthCompliance: { score: 0.9, reasoning: "Appropriate length" },
      },
    }),
  };
});

import {
  runQualityEval,
  aggregateQualityResults,
  DEFAULT_QUALITY_THRESHOLDS,
  type QualityResult,
} from "./quality";
import { getOrGenerateEvalSet } from "../pipeline/eval-set";
import { retrieveChunks } from "@/server/retrieval";
import { existsSync, readdirSync, unlinkSync } from "fs";
import { resolve } from "path";

const REPORT_DIR = resolve(__dirname, "../../data/eval-reports");

// Track files before tests, clean up new ones after
const filesBefore = existsSync(REPORT_DIR)
  ? new Set(readdirSync(REPORT_DIR))
  : new Set<string>();

afterAll(() => {
  if (existsSync(REPORT_DIR)) {
    for (const f of readdirSync(REPORT_DIR)) {
      if (!filesBefore.has(f)) unlinkSync(resolve(REPORT_DIR, f));
    }
  }
});

beforeEach(() => {
  vi.mocked(retrieveChunks).mockClear();
});

describe("runQualityEval", () => {
  it("loads eval set and runs the RAG pipeline for each question", async () => {
    await runQualityEval({ verbose: false });

    expect(getOrGenerateEvalSet).toHaveBeenCalled();
    expect(retrieveChunks).toHaveBeenCalled();
  });

  it("produces a report with expected dimensions", async () => {
    const report = await runQualityEval({ verbose: false });

    expect(report).toHaveProperty("productId");
    expect(report).toHaveProperty("model");
    expect(report).toHaveProperty("totalQuestions");
    expect(report).toHaveProperty("passRate");
    expect(report).toHaveProperty("overallScore");
    expect(report).toHaveProperty("passed");
    expect(report).toHaveProperty("dimensionAverages");
    expect(report.dimensionAverages).toHaveProperty("grounding");
    expect(report.dimensionAverages).toHaveProperty("retrievalRelevance");
    expect(report.dimensionAverages).toHaveProperty("tone");
    expect(report.dimensionAverages).toHaveProperty("lengthCompliance");
  });

  it("saves report to disk", async () => {
    await runQualityEval({ verbose: false });
    expect(existsSync(REPORT_DIR)).toBe(true);
  });

  it("returns report with pass/fail status", async () => {
    const report = await runQualityEval({ verbose: false });
    expect(typeof report.passed).toBe("boolean");
  });

  it("evaluates all questions from the eval set", async () => {
    const report = await runQualityEval({ verbose: false });
    expect(report.totalQuestions).toBe(2);
    expect(report.results).toHaveLength(2);
  });

  it("includes generated answer in each result", async () => {
    const report = await runQualityEval({ verbose: false });
    for (const result of report.results) {
      expect(result.answer).toBeTruthy();
      expect(typeof result.answer).toBe("string");
      expect(result.retrievedChunkCount).toBeGreaterThanOrEqual(0);
    }
  });

  it("returns the generated answer — not the golden answer from the eval set", async () => {
    // The eval set's golden answer is "No, do not use in wet areas." and the
    // generator mock returns a distinct, longer answer. If the runner ever
    // starts echoing the golden answer instead of the model's output, this
    // test will catch it.
    const report = await runQualityEval({ verbose: false });
    for (const result of report.results) {
      expect(result.answer).not.toBe("No, do not use in wet areas.");
      expect(result.answer).toMatch(/wet areas/i);
      expect(result.answer.length).toBeGreaterThan(
        "No, do not use in wet areas.".length,
      );
    }
  });

  it("retrieves chunks for every question in the eval set", async () => {
    await runQualityEval({ verbose: false });
    // Two-question eval set → two retrieval calls, in order.
    expect(retrieveChunks).toHaveBeenCalledTimes(2);
    const questions = vi
      .mocked(retrieveChunks)
      .mock.calls.map((c) => c[0] as string);
    expect(questions).toEqual(
      expect.arrayContaining([
        "Is it safe to use in wet areas?",
        "What are all the cleaning modes?",
      ]),
    );
  });
});

describe("aggregateQualityResults", () => {
  const mockResults: QualityResult[] = [
    {
      question: "Q1",
      answer: "A1",
      retrievedChunkCount: 3,
      judgment: {
        grounding: { score: 0.9, reasoning: "good" },
        retrievalRelevance: { score: 0.8, reasoning: "good" },
        tone: { score: 0.85, reasoning: "good" },
        lengthCompliance: { score: 0.9, reasoning: "good" },
      },
      averageScore: 0.863,
    },
    {
      question: "Q2",
      answer: "A2",
      retrievedChunkCount: 2,
      judgment: {
        grounding: { score: 0.7, reasoning: "ok" },
        retrievalRelevance: { score: 0.6, reasoning: "ok" },
        tone: { score: 0.75, reasoning: "ok" },
        lengthCompliance: { score: 0.8, reasoning: "ok" },
      },
      averageScore: 0.713,
    },
  ];

  it("computes correct pass rate", () => {
    const report = aggregateQualityResults(
      mockResults,
      "test-product",
      DEFAULT_QUALITY_THRESHOLDS,
    );
    expect(report.passRate).toBe(1);
    expect(report.passedQuestions).toBe(2);
  });

  it("computes correct dimension averages", () => {
    const report = aggregateQualityResults(mockResults, "test-product");
    expect(report.dimensionAverages.grounding).toBe(0.8);
    expect(report.dimensionAverages.retrievalRelevance).toBe(0.7);
    expect(report.dimensionAverages.tone).toBe(0.8);
    expect(report.dimensionAverages.lengthCompliance).toBe(0.85);
  });

  it("marks report as passed when thresholds are met", () => {
    const report = aggregateQualityResults(mockResults, "test-product");
    expect(report.passed).toBe(true);
  });

  it("marks report as failed when below threshold", () => {
    const report = aggregateQualityResults(mockResults, "test-product", {
      perQuestion: 0.9,
      overall: 0.95,
      passRate: 1.0,
    });
    expect(report.passed).toBe(false);
  });

  it("handles empty results", () => {
    const report = aggregateQualityResults([], "test-product");
    expect(report.totalQuestions).toBe(0);
    expect(report.overallScore).toBe(0);
    expect(report.passRate).toBe(0);
  });
});
