import { describe, it, expect, vi, afterAll, beforeEach } from "vitest";

// Mock all external dependencies to test the runner infrastructure
vi.mock("../pipeline/extract-markdown", () => ({
  extractToMarkdown: vi.fn().mockResolvedValue({
    markdown: "## Safety Information\n\nDo not use in wet areas",
    cached: true,
  }),
}));

vi.mock("../pipeline/chunk", () => ({
  chunkMarkdown: vi.fn().mockReturnValue([
    {
      text: "Do not use in wet areas",
      pageNumbers: [],
      sectionHeader: "Safety Information",
      index: 0,
    },
  ]),
  DEFAULT_CHUNK_CONFIG: {
    chunkSize: 2000,
    overlap: 200,
    minChunkSize: 100,
    splitPatterns: [],
  },
}));

vi.mock("../pipeline/metadata", () => ({
  enrichChunks: vi.fn().mockReturnValue([
    {
      text: "Do not use in wet areas",
      metadata: {
        sectionHeader: "Safety Information",
        pageNumbers: [],
        chunkIndex: 0,
        charCount: 23,
        tokenCount: 6,
      },
      context: "",
      embeddingInput: "Do not use in wet areas",
    },
  ]),
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
        claims: [
          "The device should not be used in wet areas",
          "Wet area usage is a safety concern",
        ],
        relevantSections: ["Safety Information"],
      },
    ],
  }),
}));

vi.mock("@/server/db/vectors", () => ({
  similaritySearch: vi.fn().mockResolvedValue([
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

vi.mock("../pipeline/judge", () => ({
  judgeRetrieval: vi.fn().mockResolvedValue({
    question: "Is it safe to use in wet areas?",
    expectedAnswer: "No, do not use in wet areas.",
    retrievedTexts: ["Do not use in wet areas. Safety warning."],
    judgment: {
      faithfulness: { score: 0.95, reasoning: "good" },
      contextRecall: { score: 0.85, reasoning: "2/2 claims attributed" },
      contextPrecision: { score: 0.8, reasoning: "1/1 chunks useful" },
    },
    averageScore: 0.867,
    contextRecallDetail: {
      claimAttributions: [
        {
          claim: "The device should not be used in wet areas",
          attributed: true,
          chunkIndex: 1,
          reasoning: "Found in chunk 1",
        },
        {
          claim: "Wet area usage is a safety concern",
          attributed: true,
          chunkIndex: 1,
          reasoning: "Implied by safety warning",
        },
      ],
      score: 1.0,
    },
    contextPrecisionDetail: {
      chunkVerdicts: [
        {
          chunkIndex: 1,
          useful: true,
          reasoning: "Contains safety information",
        },
      ],
      score: 1.0,
    },
  }),
  computeSecondaryScores: vi.fn().mockReturnValue({
    chunkSizeDistribution: { score: 0.9, reasoning: "ok" },
    deduplication: { score: 1, reasoning: "ok" },
    metadataQuality: { score: 0.9, reasoning: "ok" },
    sectionCoverage: { score: 0.8, reasoning: "ok" },
    sentenceCompleteness: { score: 0.9, reasoning: "ok" },
    structuralIntegrity: { score: 1, reasoning: "ok" },
  }),
  aggregateResults: vi.fn().mockReturnValue({
    productId: "dreame-x40-ultra",
    timestamp: "2025-01-01T00:00:00.000Z",
    totalQuestions: 1,
    passedQuestions: 1,
    passRate: 1,
    overallScore: 0.867,
    dimensionAverages: {
      faithfulness: 0.95,
      contextRecall: 0.85,
      contextPrecision: 0.8,
    },
    secondaryScores: {
      chunkSizeDistribution: { score: 0.9, reasoning: "ok" },
      deduplication: { score: 1, reasoning: "ok" },
      metadataQuality: { score: 0.9, reasoning: "ok" },
      sectionCoverage: { score: 0.8, reasoning: "ok" },
      sentenceCompleteness: { score: 0.9, reasoning: "ok" },
      structuralIntegrity: { score: 1, reasoning: "ok" },
    },
    thresholds: { perQuestion: 0.5, overall: 0.65, passRate: 0.8 },
    passed: true,
    results: [],
  }),
  DEFAULT_THRESHOLDS: { perQuestion: 0.5, overall: 0.65, passRate: 0.8 },
}));

vi.mock("@/server/db/client", () => ({
  getDb: vi.fn().mockResolvedValue({}),
}));

import { runIngestionEval } from "./ingestion";
import { getOrGenerateEvalSet } from "../pipeline/eval-set";
import { judgeRetrieval, aggregateResults } from "../pipeline/judge";
import { similaritySearch } from "@/server/db/vectors";
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
  // Reset call history between tests so judgeRetrieval.mock.calls[0] is the
  // invocation from the current test, not a stale prior run.
  vi.mocked(judgeRetrieval).mockClear();
  vi.mocked(similaritySearch).mockClear();
});

describe("runIngestionEval", () => {
  it("loads eval set and runs judgments", async () => {
    await runIngestionEval({ verbose: false });

    expect(getOrGenerateEvalSet).toHaveBeenCalled();
    expect(similaritySearch).toHaveBeenCalled();
    expect(judgeRetrieval).toHaveBeenCalled();
    expect(aggregateResults).toHaveBeenCalled();
  });

  it("feeds similaritySearch output into judgeRetrieval for the same question", async () => {
    await runIngestionEval({ verbose: false });

    // The search returns one chunk whose text is "Do not use in wet areas...".
    // That exact text must appear in the chunks handed to judgeRetrieval so we
    // know the runner wires retrieval → judgment, not two independent streams.
    const judgeCall = vi.mocked(judgeRetrieval).mock.calls[0];
    expect(judgeCall).toBeDefined();
    const [qa, chunks] = judgeCall as unknown as [
      { question: string },
      Array<{ text: string }>,
    ];
    expect(qa.question).toBe("Is it safe to use in wet areas?");
    expect(chunks.map((c) => c.text)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Do not use in wet areas"),
      ]),
    );
  });

  it("produces a report with expected fields", async () => {
    const report = await runIngestionEval({ verbose: false });

    expect(report).toHaveProperty("productId");
    expect(report).toHaveProperty("totalQuestions");
    expect(report).toHaveProperty("passRate");
    expect(report).toHaveProperty("overallScore");
    expect(report).toHaveProperty("passed");
    expect(report).toHaveProperty("dimensionAverages");
  });

  it("report has the three RAGAS retrieval metric dimensions", async () => {
    const report = await runIngestionEval({ verbose: false });

    expect(report.dimensionAverages).toHaveProperty("faithfulness");
    expect(report.dimensionAverages).toHaveProperty("contextRecall");
    expect(report.dimensionAverages).toHaveProperty("contextPrecision");
    expect(report.dimensionAverages).not.toHaveProperty("coherence");
  });

  it("saves report to disk", async () => {
    await runIngestionEval({ verbose: false });

    expect(existsSync(REPORT_DIR)).toBe(true);
  });

  it("returns report with pass/fail status", async () => {
    const report = await runIngestionEval({ verbose: false });

    expect(typeof report.passed).toBe("boolean");
    expect(report.passed).toBe(true);
  });
});
