import { resolve } from "path";
import { extractToMarkdown } from "../pipeline/extract-markdown";
import { chunkMarkdown, DEFAULT_CHUNK_CONFIG } from "../pipeline/chunk";
import { enrichChunks } from "../pipeline/metadata";
import { getOrGenerateEvalSet } from "../pipeline/eval-set";
import {
  judgeRetrieval,
  computeSecondaryScores,
  aggregateResults,
  DEFAULT_THRESHOLDS,
  type ScoreThresholds,
  type EvalReport,
} from "../pipeline/judge";
import { similaritySearch } from "@/server/db/vectors";
import { getDb } from "@/server/db/client";
import { writeFileSync, mkdirSync, existsSync } from "fs";

const DEFAULT_PDF_PATH = resolve(
  __dirname,
  "../../data/example-product-pdf.pdf",
);
const DEFAULT_PRODUCT_ID = "dreame-x40-ultra";
const REPORT_DIR = resolve(__dirname, "../../data/eval-reports");

export interface IngestionEvalOptions {
  pdfPath?: string;
  productId?: string;
  thresholds?: ScoreThresholds;
  verbose?: boolean;
}

/**
 * Runs the standalone ingestion eval suite (Suite 4).
 *
 * This evaluates the quality of already-ingested chunks by:
 * 1. Extracting PDF to Markdown (or using cache) for eval set generation
 * 2. Loading or generating a golden Q&A eval set from the Markdown
 * 3. Running each golden question against the existing vector store
 * 4. Using per-metric LLM judges (Faithfulness, Context Recall, Context Precision)
 * 5. Computing secondary chunk quality scores (including section coverage)
 * 6. Generating a pass/fail report
 *
 * Unlike the feedback loop, this does NOT re-chunk or adjust parameters.
 * It evaluates whatever is currently in the vector store.
 */
export async function runIngestionEval(
  options: IngestionEvalOptions = {},
): Promise<EvalReport> {
  const {
    pdfPath = DEFAULT_PDF_PATH,
    productId = DEFAULT_PRODUCT_ID,
    thresholds = DEFAULT_THRESHOLDS,
    verbose = false,
  } = options;

  const log = (msg: string) => {
    if (verbose) console.log(msg);
  };

  // Step 1: Extract PDF to Markdown (uses cache if available)
  log("Extracting PDF to Markdown...");
  const { markdown, cached } = await extractToMarkdown(pdfPath, productId);
  log(`  Extraction: ${cached ? "using cache" : "fresh via Gemini"}`);

  // Step 2: Get or generate golden Q&A eval set from Markdown
  log("Getting eval set (cached or generating)...");
  const evalSet = await getOrGenerateEvalSet(markdown, productId);
  log(`  Eval set: ${evalSet.items.length} golden Q&A pairs`);

  // Step 3: Connect to DB and judge each question
  const db = await getDb();
  log("Judging retrieval quality (3 metrics per question)...");

  const results = [];
  for (const qa of evalSet.items) {
    log(`  Judging: "${qa.question.substring(0, 60)}..."`);
    const retrievedChunks = await similaritySearch(db, qa.question, {
      productId,
      topK: 5,
      minScore: 0.3,
    });
    const judgment = await judgeRetrieval(qa, retrievedChunks);
    results.push(judgment);

    if (verbose) {
      const j = judgment.judgment;
      log(
        `    Faithfulness=${j.faithfulness.score} Recall=${j.contextRecall.score} Precision=${j.contextPrecision.score} → avg=${judgment.averageScore}`,
      );

      // Log per-claim breakdown for Context Recall
      if (judgment.contextRecallDetail?.claimAttributions.length) {
        const detail = judgment.contextRecallDetail;
        const missed = detail.claimAttributions.filter((a) => !a.attributed);
        if (missed.length > 0) {
          log(`    Missing claims:`);
          for (const m of missed) {
            log(`      ✗ "${m.claim}" — ${m.reasoning}`);
          }
        }
      }
    }
  }

  // Step 4: Compute secondary scores from current chunking
  // Re-chunk locally to compute secondary scores (doesn't modify DB)
  const rawChunks = chunkMarkdown(markdown, DEFAULT_CHUNK_CONFIG);
  const enrichedChunks = enrichChunks(rawChunks);
  const secondaryScores = computeSecondaryScores(
    enrichedChunks,
    results,
    evalSet.items,
  );

  // Step 5: Aggregate and report
  const report = aggregateResults(
    results,
    secondaryScores,
    productId,
    thresholds,
  );

  // Step 6: Save report
  if (!existsSync(REPORT_DIR)) {
    mkdirSync(REPORT_DIR, { recursive: true });
  }
  const filename = `ingestion-eval-${productId}-${report.timestamp.replace(/[:.]/g, "-")}.json`;
  const reportPath = resolve(REPORT_DIR, filename);
  writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf-8");

  log(`\n--- Ingestion Eval Results ---`);
  log(`  Overall score: ${report.overallScore.toFixed(3)}`);
  log(`  Pass rate: ${(report.passRate * 100).toFixed(1)}%`);
  log(`  Faithfulness: ${report.dimensionAverages.faithfulness.toFixed(3)}`);
  log(`  Context Recall: ${report.dimensionAverages.contextRecall.toFixed(3)}`);
  log(
    `  Context Precision: ${report.dimensionAverages.contextPrecision.toFixed(3)}`,
  );
  log(`  Passed: ${report.passed ? "YES" : "NO"}`);
  log(`  Report saved: ${reportPath}`);

  return report;
}

// CLI entry point — only runs when executed directly (not when imported in tests)
async function main() {
  const verbose = process.argv.includes("--verbose") || true;

  try {
    const report = await runIngestionEval({ verbose });
    process.exit(report.passed ? 0 : 1);
  } catch (error) {
    console.error("Ingestion eval failed:", error);
    process.exit(1);
  }
}

const isMainModule =
  typeof process !== "undefined" &&
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/.*\//, ""));

if (isMainModule) {
  main();
}
