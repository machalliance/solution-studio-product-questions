import { describe, it, expect, vi, afterAll } from "vitest";

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
        question: "What is the suction power?",
        answer: "12000Pa suction power.",
        sourcePassage: "Suction power: 12000Pa",
        topic: "specifications",
      },
      {
        question: "How does the self-cleaning system work?",
        answer: "The self-cleaning system automatically washes the mop.",
        sourcePassage: "Self-cleaning: auto mop washing with hot water",
        topic: "features",
      },
      {
        question: "What are all the cleaning modes?",
        answer: "Auto, manual, and spot cleaning modes.",
        sourcePassage: "Cleaning modes: auto, manual, spot",
        topic: "usage",
      },
    ],
  }),
}));

vi.mock("@/server/retrieval", () => ({
  retrieveChunks: vi.fn().mockResolvedValue([
    {
      text: "Suction power: 12000Pa",
      metadata: {
        sectionHeader: "Specs",
        pageNumbers: [5],
        chunkIndex: 3,
        charCount: 22,
        tokenCount: 8,
      },
      score: 0.95,
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
      text: "The suction power is 12000Pa.",
    }),
  };
});

vi.mock("@/server/db/vectors", () => ({
  generateEmbeddings: vi.fn().mockResolvedValue([
    [0.1, 0.2, 0.3],
    [0.4, 0.5, 0.6],
    [0.7, 0.8, 0.9],
  ]),
}));

import {
  runPerformanceEval,
  computeLatencyStats,
  classifyQuestionComplexity,
  type LatencyMeasurement,
} from "./performance";
import { getOrGenerateEvalSet } from "../pipeline/eval-set";
import { generateEmbeddings } from "@/server/db/vectors";
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

describe("runPerformanceEval", () => {
  it("loads eval set and measures latency for each question", async () => {
    await runPerformanceEval({ verbose: false });

    expect(getOrGenerateEvalSet).toHaveBeenCalled();
  });

  it("produces a report with latency stats", async () => {
    const report = await runPerformanceEval({ verbose: false });

    expect(report).toHaveProperty("productId");
    expect(report).toHaveProperty("model");
    expect(report).toHaveProperty("latency");
    expect(report.latency).toHaveProperty("simple");
    expect(report.latency).toHaveProperty("complex");
    expect(report.latency.simple).toHaveProperty("avgMs");
    expect(report.latency.simple).toHaveProperty("p50Ms");
    expect(report.latency.simple).toHaveProperty("p95Ms");
  });

  it("includes embedding benchmark", async () => {
    const report = await runPerformanceEval({ verbose: false });

    expect(report).toHaveProperty("embedding");
    expect(report.embedding).toHaveProperty("textCount");
    expect(report.embedding).toHaveProperty("totalMs");
    expect(report.embedding).toHaveProperty("avgMsPerText");
    expect(generateEmbeddings).toHaveBeenCalled();
  });

  it("saves report to disk", async () => {
    await runPerformanceEval({ verbose: false });
    expect(existsSync(REPORT_DIR)).toBe(true);
  });

  it("includes individual measurements", async () => {
    const report = await runPerformanceEval({ verbose: false });

    expect(report.measurements).toHaveLength(3);
    for (const m of report.measurements) {
      expect(m).toHaveProperty("question");
      expect(m).toHaveProperty("type");
      expect(m).toHaveProperty("retrievalMs");
      expect(m).toHaveProperty("generationMs");
      expect(m).toHaveProperty("totalMs");
      expect(["simple", "complex"]).toContain(m.type);
    }
  });

  it("classifies questions by complexity", async () => {
    const report = await runPerformanceEval({ verbose: false });

    // "What is the suction power?" → simple
    // "How does the self-cleaning system work?" → complex (matches "how does X work")
    // "What are all the cleaning modes?" → complex (matches "all X modes")
    const types = report.measurements.map((m) => m.type);
    expect(types).toContain("simple");
    expect(types).toContain("complex");
  });
});

describe("computeLatencyStats", () => {
  it("computes correct stats from measurements", () => {
    const measurements: LatencyMeasurement[] = [
      {
        question: "Q1",
        type: "simple",
        retrievalMs: 50,
        generationMs: 200,
        totalMs: 250,
      },
      {
        question: "Q2",
        type: "simple",
        retrievalMs: 60,
        generationMs: 300,
        totalMs: 360,
      },
      {
        question: "Q3",
        type: "simple",
        retrievalMs: 40,
        generationMs: 150,
        totalMs: 190,
      },
    ];

    const stats = computeLatencyStats(measurements);

    expect(stats.count).toBe(3);
    expect(stats.avgMs).toBe(267); // (250+360+190) / 3
    expect(stats.minMs).toBe(190);
    expect(stats.maxMs).toBe(360);
    expect(stats.p50Ms).toBe(250); // sorted: [190, 250, 360], index 1
  });

  it("handles empty measurements", () => {
    const stats = computeLatencyStats([]);

    expect(stats.count).toBe(0);
    expect(stats.avgMs).toBe(0);
    expect(stats.minMs).toBe(0);
    expect(stats.maxMs).toBe(0);
  });

  it("handles single measurement", () => {
    const measurements: LatencyMeasurement[] = [
      {
        question: "Q1",
        type: "simple",
        retrievalMs: 100,
        generationMs: 500,
        totalMs: 600,
      },
    ];

    const stats = computeLatencyStats(measurements);

    expect(stats.count).toBe(1);
    expect(stats.avgMs).toBe(600);
    expect(stats.minMs).toBe(600);
    expect(stats.maxMs).toBe(600);
    expect(stats.p50Ms).toBe(600);
    expect(stats.p95Ms).toBe(600);
  });
});

describe("classifyQuestionComplexity", () => {
  it("classifies fact-lookup questions as simple", () => {
    expect(classifyQuestionComplexity("What is the suction power?")).toBe(
      "simple",
    );
    expect(classifyQuestionComplexity("How much does it cost?")).toBe("simple");
    expect(classifyQuestionComplexity("Is it waterproof?")).toBe("simple");
  });

  it('classifies "how does X work" as complex', () => {
    expect(
      classifyQuestionComplexity("How does the self-cleaning system work?"),
    ).toBe("complex");
    expect(classifyQuestionComplexity("How does the mop work?")).toBe(
      "complex",
    );
  });

  it('classifies "all X modes/settings/options" as complex', () => {
    expect(classifyQuestionComplexity("What are all the cleaning modes?")).toBe(
      "complex",
    );
    expect(classifyQuestionComplexity("List all configurable settings")).toBe(
      "complex",
    );
    expect(classifyQuestionComplexity("All the options on the dock")).toBe(
      "complex",
    );
  });

  it("classifies compare/difference/explain questions as complex", () => {
    expect(classifyQuestionComplexity("Compare this to the base model")).toBe(
      "complex",
    );
    expect(
      classifyQuestionComplexity("What is the difference between modes?"),
    ).toBe("complex");
    expect(classifyQuestionComplexity("Explain the navigation")).toBe(
      "complex",
    );
  });

  it("is case-insensitive", () => {
    expect(classifyQuestionComplexity("HOW DOES THE DOCK WORK?")).toBe(
      "complex",
    );
    expect(classifyQuestionComplexity("COMPARE TO X")).toBe("complex");
  });

  it("does not mis-classify short simple questions as complex", () => {
    // No complex indicator present
    expect(classifyQuestionComplexity("price?")).toBe("simple");
    expect(classifyQuestionComplexity("weight")).toBe("simple");
    expect(classifyQuestionComplexity("color options")).toBe("simple");
  });
});
