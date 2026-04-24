import { describe, it, expect } from "vitest";
import type { EnrichedChunk } from "./metadata";
import type { JudgmentResult, SecondaryScores, ScoreThresholds } from "./judge";
import { computeSecondaryScores, aggregateResults } from "./judge";
import type { GoldenQA } from "./eval-set";

// --- Helper factories ---

function makeChunk(
  text: string,
  overrides: Partial<EnrichedChunk["metadata"]> = {},
): EnrichedChunk {
  return {
    text,
    context: "",
    embeddingInput: text,
    metadata: {
      sectionHeader: overrides.sectionHeader ?? "Test Section",
      pageNumbers: overrides.pageNumbers ?? [1],
      chunkIndex: overrides.chunkIndex ?? 0,
      charCount: text.length,
      tokenCount: Math.max(1, Math.ceil(text.length / 4)),
    },
  };
}

function makeJudgmentResult(
  overrides: Partial<{
    faithfulness: number;
    contextRecall: number;
    contextPrecision: number;
  }> = {},
): JudgmentResult {
  const faithfulness = overrides.faithfulness ?? 0.9;
  const contextRecall = overrides.contextRecall ?? 0.85;
  const contextPrecision = overrides.contextPrecision ?? 0.75;
  const avg = (faithfulness + contextRecall + contextPrecision) / 3;

  return {
    question: "Test question?",
    expectedAnswer: "Test answer",
    retrievedTexts: ["chunk text"],
    judgment: {
      faithfulness: { score: faithfulness, reasoning: "test" },
      contextRecall: { score: contextRecall, reasoning: "test" },
      contextPrecision: { score: contextPrecision, reasoning: "test" },
    },
    averageScore: Math.round(avg * 1000) / 1000,
  };
}

// --- Secondary scores ---

describe("computeSecondaryScores", () => {
  it("returns high size distribution score for uniform chunks", () => {
    const chunks = [
      makeChunk("a".repeat(500)),
      makeChunk("b".repeat(520)),
      makeChunk("c".repeat(480)),
    ];

    const scores = computeSecondaryScores(chunks);
    expect(scores.chunkSizeDistribution.score).toBeGreaterThan(0.9);
  });

  it("returns lower size distribution score for highly variable chunks", () => {
    const chunks = [
      makeChunk("a".repeat(100)),
      makeChunk("b".repeat(2000)),
      makeChunk("c".repeat(50)),
    ];

    const scores = computeSecondaryScores(chunks);
    expect(scores.chunkSizeDistribution.score).toBeLessThan(0.5);
  });

  it("detects near-duplicate chunks", () => {
    const text = "This is the exact same text repeated for testing purposes";
    const chunks = [
      makeChunk(text),
      makeChunk(text),
      makeChunk("Different text entirely here"),
    ];

    const scores = computeSecondaryScores(chunks);
    expect(scores.deduplication.score).toBeLessThan(1);
  });

  it("returns perfect dedup score when no duplicates exist", () => {
    const chunks = [
      makeChunk(
        "First chunk about cleaning the robot vacuum filter system thoroughly",
      ),
      makeChunk(
        "Second chunk about setting up the base station charging dock properly",
      ),
      makeChunk(
        "Third chunk about troubleshooting error codes and warning lights",
      ),
    ];

    const scores = computeSecondaryScores(chunks);
    expect(scores.deduplication.score).toBe(1);
  });

  it("scores metadata quality as the fraction of chunks with citation-grade metadata", () => {
    const chunks = [
      makeChunk("text", {
        sectionHeader: "Safety",
        pageNumbers: [1],
      }),
      makeChunk("text", {
        sectionHeader: "",
        pageNumbers: [],
      }),
    ];

    const scores = computeSecondaryScores(chunks);
    // First chunk passes (section + pages); second fails (neither) → 0.5.
    expect(scores.metadataQuality.score).toBeCloseTo(0.5, 1);
  });

  it("fails chunks whose section header is too short to be informative", () => {
    const chunks = [
      makeChunk("text", { sectionHeader: "Safety", pageNumbers: [1] }),
      makeChunk("text", { sectionHeader: "1", pageNumbers: [2] }),
    ];

    const scores = computeSecondaryScores(chunks);
    // First passes, second fails (header shorter than MIN_SECTION_HEADER_LENGTH).
    expect(scores.metadataQuality.score).toBeCloseTo(0.5, 1);
  });

  it("fails chunks missing page numbers even when the section is informative", () => {
    const chunks = [
      makeChunk("text", {
        sectionHeader: "Troubleshooting Guide",
        pageNumbers: [],
      }),
    ];

    const scores = computeSecondaryScores(chunks);
    expect(scores.metadataQuality.score).toBe(0);
  });

  it("returns perfect metadata score when all chunks have citation-grade metadata", () => {
    const chunks = [
      makeChunk("text", { sectionHeader: "Safety", pageNumbers: [1] }),
      makeChunk("text", { sectionHeader: "Setup", pageNumbers: [2] }),
    ];

    const scores = computeSecondaryScores(chunks);
    expect(scores.metadataQuality.score).toBe(1);
  });

  it("returns zero section coverage when no eval results provided", () => {
    const chunks = [makeChunk("text")];
    const scores = computeSecondaryScores(chunks);
    expect(scores.sectionCoverage.score).toBe(0);
    expect(scores.sectionCoverage.reasoning).toContain("Not computed");
  });

  it("computes section coverage from eval results", () => {
    const chunks = [makeChunk("text")];

    const results: JudgmentResult[] = [
      {
        ...makeJudgmentResult(),
        retrievedTexts: [
          "This chunk talks about safety information and warnings",
        ],
      },
      {
        ...makeJudgmentResult(),
        retrievedTexts: ["This chunk is about something unrelated"],
      },
    ];

    const evalItems: GoldenQA[] = [
      {
        question: "Q1",
        answer: "A1",
        sourcePassage: "S1",
        topic: "safety",
        claims: ["claim1"],
        relevantSections: ["Safety Information"],
      },
      {
        question: "Q2",
        answer: "A2",
        sourcePassage: "S2",
        topic: "setup",
        claims: ["claim2"],
        relevantSections: ["Setup Guide"],
      },
    ];

    const scores = computeSecondaryScores(chunks, results, evalItems);
    // First question's retrieved text contains "safety information" → match
    // Second question's retrieved text doesn't contain "setup guide" → no match
    expect(scores.sectionCoverage.score).toBe(0.5);
    expect(scores.sectionCoverage.reasoning).toContain("1/2");
  });
});

// --- Aggregation ---

describe("aggregateResults", () => {
  const dummySecondary: SecondaryScores = {
    chunkSizeDistribution: { score: 0.9, reasoning: "good" },
    deduplication: { score: 1, reasoning: "no dupes" },
    metadataQuality: { score: 0.85, reasoning: "good" },
    sectionCoverage: { score: 0.7, reasoning: "ok" },
    sentenceCompleteness: { score: 0.9, reasoning: "good" },
    structuralIntegrity: { score: 1, reasoning: "good" },
  };

  it("computes correct pass/fail for high-scoring results", () => {
    const results = [
      makeJudgmentResult({
        faithfulness: 0.9,
        contextRecall: 0.9,
        contextPrecision: 0.9,
      }),
      makeJudgmentResult({
        faithfulness: 0.85,
        contextRecall: 0.8,
        contextPrecision: 0.8,
      }),
      makeJudgmentResult({
        faithfulness: 0.9,
        contextRecall: 0.85,
        contextPrecision: 0.85,
      }),
    ];

    const report = aggregateResults(results, dummySecondary, "test-product");

    expect(report.passed).toBe(true);
    expect(report.overallScore).toBeGreaterThan(0.7);
    expect(report.passRate).toBe(1);
    expect(report.totalQuestions).toBe(3);
    expect(report.passedQuestions).toBe(3);
  });

  it("computes correct pass/fail for low-scoring results", () => {
    const results = [
      makeJudgmentResult({
        faithfulness: 0.2,
        contextRecall: 0.1,
        contextPrecision: 0.1,
      }),
      makeJudgmentResult({
        faithfulness: 0.3,
        contextRecall: 0.2,
        contextPrecision: 0.2,
      }),
      makeJudgmentResult({
        faithfulness: 0.1,
        contextRecall: 0.1,
        contextPrecision: 0.1,
      }),
    ];

    const report = aggregateResults(results, dummySecondary, "test-product");

    expect(report.passed).toBe(false);
    expect(report.overallScore).toBeLessThan(0.7);
    expect(report.passRate).toBe(0);
  });

  it("respects custom thresholds", () => {
    const lenientThresholds: ScoreThresholds = {
      perQuestion: 0.3,
      overall: 0.3,
      passRate: 0.5,
    };

    const results = [
      makeJudgmentResult({
        faithfulness: 0.4,
        contextRecall: 0.4,
        contextPrecision: 0.4,
      }),
      makeJudgmentResult({
        faithfulness: 0.5,
        contextRecall: 0.5,
        contextPrecision: 0.5,
      }),
    ];

    const report = aggregateResults(
      results,
      dummySecondary,
      "test-product",
      lenientThresholds,
    );

    expect(report.passed).toBe(true);
    expect(report.thresholds).toEqual(lenientThresholds);
  });

  it("computes dimension averages correctly", () => {
    const results = [
      makeJudgmentResult({
        faithfulness: 0.8,
        contextRecall: 1.0,
        contextPrecision: 0.7,
      }),
      makeJudgmentResult({
        faithfulness: 0.6,
        contextRecall: 0.8,
        contextPrecision: 0.5,
      }),
    ];

    const report = aggregateResults(results, dummySecondary, "test-product");

    expect(report.dimensionAverages.faithfulness).toBeCloseTo(0.7, 1);
    expect(report.dimensionAverages.contextRecall).toBeCloseTo(0.9, 1);
    expect(report.dimensionAverages.contextPrecision).toBeCloseTo(0.6, 1);
  });

  it("includes product ID and timestamp", () => {
    const report = aggregateResults([], dummySecondary, "my-product");

    expect(report.productId).toBe("my-product");
    expect(report.timestamp).toBeTruthy();
    expect(new Date(report.timestamp).getTime()).not.toBeNaN();
  });

  it("handles empty results gracefully", () => {
    const report = aggregateResults([], dummySecondary, "test-product");

    expect(report.totalQuestions).toBe(0);
    expect(report.passedQuestions).toBe(0);
    expect(report.passRate).toBe(0);
    expect(report.overallScore).toBe(0);
    expect(report.passed).toBe(false);
  });
});
