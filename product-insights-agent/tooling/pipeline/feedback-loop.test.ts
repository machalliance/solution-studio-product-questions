import { describe, it, expect } from "vitest";
import type { EvalReport, SecondaryScores } from "./judge";
import { DEFAULT_THRESHOLDS } from "./judge";
import {
  DEFAULT_SWEEP_GRID,
  pickWinner,
  type SweepCell,
} from "./feedback-loop";
import { DEFAULT_CHUNK_CONFIG } from "./chunk";

function makeReport(
  overallScore: number,
  passRate: number,
  dimensionAverages: {
    faithfulness: number;
    contextRecall: number;
    contextPrecision: number;
  },
): EvalReport {
  const secondary: SecondaryScores = {
    chunkSizeDistribution: { score: 0.9, reasoning: "ok" },
    deduplication: { score: 1, reasoning: "ok" },
    metadataQuality: { score: 0.9, reasoning: "ok" },
    sectionCoverage: { score: 0.7, reasoning: "ok" },
    sentenceCompleteness: { score: 0.9, reasoning: "ok" },
    structuralIntegrity: { score: 1, reasoning: "ok" },
  };

  return {
    productId: "test",
    timestamp: new Date().toISOString(),
    totalQuestions: 10,
    passedQuestions: Math.round(10 * passRate),
    passRate,
    overallScore,
    dimensionAverages,
    secondaryScores: secondary,
    thresholds: DEFAULT_THRESHOLDS,
    passed: overallScore >= DEFAULT_THRESHOLDS.overall,
    results: [],
  };
}

function makeCell(
  chunkSize: number,
  overlap: number,
  overallScore: number,
  passRate: number,
  dims: {
    faithfulness: number;
    contextRecall: number;
    contextPrecision: number;
  },
): SweepCell {
  return {
    config: { ...DEFAULT_CHUNK_CONFIG, chunkSize, overlap },
    report: makeReport(overallScore, passRate, dims),
  };
}

describe("DEFAULT_SWEEP_GRID", () => {
  it("covers the (256, 512, 1024) × (0, 50, 100) matrix", () => {
    expect(DEFAULT_SWEEP_GRID).toHaveLength(9);
    const chunkSizes = new Set(DEFAULT_SWEEP_GRID.map((c) => c.chunkSize));
    const overlaps = new Set(DEFAULT_SWEEP_GRID.map((c) => c.overlap));
    expect(chunkSizes).toEqual(new Set([256, 512, 1024]));
    expect(overlaps).toEqual(new Set([0, 50, 100]));
  });
});

describe("pickWinner", () => {
  it("picks the cell with the highest overall score", () => {
    const cells = [
      makeCell(256, 0, 0.6, 0.7, {
        faithfulness: 0.6,
        contextRecall: 0.6,
        contextPrecision: 0.6,
      }),
      makeCell(512, 50, 0.82, 0.9, {
        faithfulness: 0.8,
        contextRecall: 0.8,
        contextPrecision: 0.8,
      }),
      makeCell(1024, 100, 0.71, 0.75, {
        faithfulness: 0.7,
        contextRecall: 0.75,
        contextPrecision: 0.7,
      }),
    ];

    const winner = pickWinner(cells);
    expect(winner.config.chunkSize).toBe(512);
    expect(winner.config.overlap).toBe(50);
  });

  it("breaks ties on overall score using pass rate", () => {
    const cells = [
      makeCell(256, 0, 0.75, 0.7, {
        faithfulness: 0.75,
        contextRecall: 0.75,
        contextPrecision: 0.75,
      }),
      makeCell(512, 50, 0.75, 0.9, {
        faithfulness: 0.75,
        contextRecall: 0.75,
        contextPrecision: 0.75,
      }),
    ];

    const winner = pickWinner(cells);
    expect(winner.config.chunkSize).toBe(512);
  });

  it("breaks ties on overall + pass rate using context recall", () => {
    const cells = [
      makeCell(256, 0, 0.75, 0.8, {
        faithfulness: 0.8,
        contextRecall: 0.7,
        contextPrecision: 0.75,
      }),
      makeCell(512, 50, 0.75, 0.8, {
        faithfulness: 0.7,
        contextRecall: 0.9,
        contextPrecision: 0.65,
      }),
    ];

    const winner = pickWinner(cells);
    expect(winner.config.chunkSize).toBe(512);
  });

  it("throws if called on an empty sweep", () => {
    expect(() => pickWinner([])).toThrow();
  });
});
