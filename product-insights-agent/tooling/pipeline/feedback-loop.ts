import { writeFileSync, mkdirSync, existsSync } from "fs";
import { resolve } from "path";
import { chunkMarkdown, DEFAULT_CHUNK_CONFIG, type ChunkConfig } from "./chunk";
import { enrichChunks } from "./metadata";
import type { GoldenQA } from "./eval-set";
import {
  judgeRetrieval,
  computeSecondaryScores,
  aggregateResults,
  DEFAULT_THRESHOLDS,
  type EvalReport,
  type ScoreThresholds,
} from "./judge";
import {
  insertChunks,
  createVectorIndex,
  similaritySearch,
} from "@/server/db/vectors";
import type { Db } from "mongodb";

const REPORT_DIR = resolve(__dirname, "../../data/eval-reports");

/**
 * Fixed grid of (chunkSize, overlap) configs swept during a single run.
 *
 * Chosen to cover the space production teams actually care about:
 *   - 256 tokens ≈ paragraph-granular, biases toward precision
 *   - 512 tokens ≈ section-granular (our default), balanced
 *   - 1024 tokens ≈ multi-section, biases toward recall
 *   - overlap 0  = sections are fully disjoint
 *   - overlap 50 = ~10% overlap, mild boundary coverage
 *   - overlap 100 = ~20% overlap, aggressive boundary coverage
 *
 * This is NOT a search space to be iterated/optimized — it's a diagnostic
 * A/B grid so a human can read the scorecard and pick a winner to freeze.
 * See docs/production-scaling/ingestion.md for why we don't auto-tune.
 */
export const DEFAULT_SWEEP_GRID: Array<
  Pick<ChunkConfig, "chunkSize" | "overlap">
> = [
  { chunkSize: 256, overlap: 0 },
  { chunkSize: 256, overlap: 50 },
  { chunkSize: 256, overlap: 100 },
  { chunkSize: 512, overlap: 0 },
  { chunkSize: 512, overlap: 50 },
  { chunkSize: 512, overlap: 100 },
  { chunkSize: 1024, overlap: 0 },
  { chunkSize: 1024, overlap: 50 },
  { chunkSize: 1024, overlap: 100 },
];

export interface SweepOptions {
  markdown: string;
  evalSet: GoldenQA[];
  productId: string;
  db: Db;
  baseConfig?: ChunkConfig;
  grid?: Array<Pick<ChunkConfig, "chunkSize" | "overlap">>;
  thresholds?: ScoreThresholds;
  verbose?: boolean;
}

export interface SweepCell {
  config: ChunkConfig;
  report: EvalReport;
}

export interface SweepResult {
  cells: SweepCell[];
  /** Highest overall-score cell. Humans should still read the full table. */
  winner: SweepCell;
}

function log(verbose: boolean, ...args: unknown[]) {
  if (verbose) console.log(...args);
}

/**
 * Saves an eval report to disk as a timestamped JSON file.
 */
export function saveReport(report: EvalReport): string {
  if (!existsSync(REPORT_DIR)) {
    mkdirSync(REPORT_DIR, { recursive: true });
  }
  const filename = `${report.productId}-${report.timestamp.replace(/[:.]/g, "-")}.json`;
  const path = resolve(REPORT_DIR, filename);
  writeFileSync(path, JSON.stringify(report, null, 2), "utf-8");
  return path;
}

/**
 * Runs a one-shot grid sweep across chunk configs.
 *
 * For each (chunkSize, overlap) in the grid:
 *   1. Re-chunk the Markdown with that config
 *   2. Replace the product's chunks in MongoDB
 *   3. Judge every golden Q&A against the fresh retrieval
 *   4. Record the report
 *
 * Emits a scorecard table and returns the highest-scoring cell as a
 * suggested winner. The intent is diagnostic: run this once during
 * pipeline design, read the table, pick a winner, freeze the config.
 *
 * This replaces an earlier convergence-style tuner that iteratively
 * nudged chunkSize/overlap based on the weakest metric — an approach
 * that goal-hacks the eval set and hides the score landscape. See the
 * "Grid sweep vs. convergence tuner" section of
 * docs/production-scaling/ingestion.md.
 */
export async function runSweep(options: SweepOptions): Promise<SweepResult> {
  const {
    markdown,
    evalSet,
    productId,
    db,
    baseConfig = DEFAULT_CHUNK_CONFIG,
    grid = DEFAULT_SWEEP_GRID,
    thresholds = DEFAULT_THRESHOLDS,
    verbose = false,
  } = options;

  const cells: SweepCell[] = [];

  for (let i = 0; i < grid.length; i++) {
    const cellConfig: ChunkConfig = { ...baseConfig, ...grid[i] };
    log(
      verbose,
      `\n[${i + 1}/${grid.length}] chunkSize=${cellConfig.chunkSize}, overlap=${cellConfig.overlap}`,
    );

    const rawChunks = chunkMarkdown(markdown, cellConfig);
    const enrichedChunks = enrichChunks(rawChunks);
    log(verbose, `  Chunks: ${enrichedChunks.length}`);

    await insertChunks(db, enrichedChunks, productId);
    await createVectorIndex(db);

    const results = [];
    for (const qa of evalSet) {
      const retrievedChunks = await similaritySearch(db, qa.question, {
        productId,
        topK: 5,
        minScore: 0.3,
      });
      results.push(await judgeRetrieval(qa, retrievedChunks));
    }

    const secondaryScores = computeSecondaryScores(enrichedChunks);
    const report = aggregateResults(
      results,
      secondaryScores,
      productId,
      thresholds,
    );

    log(
      verbose,
      `  overall=${report.overallScore.toFixed(3)} passRate=${(report.passRate * 100).toFixed(1)}% faith=${report.dimensionAverages.faithfulness.toFixed(3)} recall=${report.dimensionAverages.contextRecall.toFixed(3)} precision=${report.dimensionAverages.contextPrecision.toFixed(3)}`,
    );

    saveReport(report);
    cells.push({ config: cellConfig, report });
  }

  const winner = pickWinner(cells);

  if (verbose) {
    printScorecard(cells, winner);
  }

  return { cells, winner };
}

/**
 * Picks the highest overall-score cell. Tie-break on pass rate, then on
 * context recall (recall regressions are the worst-feeling failures for users).
 */
export function pickWinner(cells: SweepCell[]): SweepCell {
  if (cells.length === 0) {
    throw new Error("Cannot pick a winner from an empty sweep");
  }
  return [...cells].sort((a, b) => {
    const overall = b.report.overallScore - a.report.overallScore;
    if (overall !== 0) return overall;
    const pass = b.report.passRate - a.report.passRate;
    if (pass !== 0) return pass;
    return (
      b.report.dimensionAverages.contextRecall -
      a.report.dimensionAverages.contextRecall
    );
  })[0];
}

function printScorecard(cells: SweepCell[], winner: SweepCell): void {
  console.log("\n--- Sweep scorecard ---");
  console.log(
    "  chunkSize | overlap | overall | passRate | faithfulness | recall | precision",
  );
  console.log(
    "  ----------|---------|---------|----------|--------------|--------|----------",
  );
  for (const cell of cells) {
    const isWinner =
      cell.config.chunkSize === winner.config.chunkSize &&
      cell.config.overlap === winner.config.overlap;
    const marker = isWinner ? " ← winner" : "";
    console.log(
      `  ${String(cell.config.chunkSize).padStart(9)} | ${String(cell.config.overlap).padStart(7)} | ${cell.report.overallScore.toFixed(3).padStart(7)} | ${((cell.report.passRate * 100).toFixed(1) + "%").padStart(8)} | ${cell.report.dimensionAverages.faithfulness.toFixed(3).padStart(12)} | ${cell.report.dimensionAverages.contextRecall.toFixed(3).padStart(6)} | ${cell.report.dimensionAverages.contextPrecision.toFixed(3).padStart(9)}${marker}`,
    );
  }
  console.log(
    `\n  Suggested winner: chunkSize=${winner.config.chunkSize}, overlap=${winner.config.overlap}`,
  );
  console.log(
    "  (Read the full table before freezing — the winner is an overall-score pick and may not be right for your product-mix.)",
  );
}
