import { resolve } from "path";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { extractToMarkdown } from "../pipeline/extract-markdown";
import { getOrGenerateEvalSet } from "../pipeline/eval-set";
import { getDb } from "@/server/db/client";
import { runSweep, type SweepResult } from "../pipeline/feedback-loop";

const DEFAULT_PDF_PATH = resolve(
  __dirname,
  "../../data/example-product-pdf.pdf",
);
const DEFAULT_PRODUCT_ID = "dreame-x40-ultra";
const REPORT_DIR = resolve(__dirname, "../../data/eval-reports");

function printWinnerBox(result: SweepResult): void {
  const { winner } = result;
  const { chunkSize, overlap } = winner.config;
  const { overallScore, dimensionAverages } = winner.report;

  const title = `Recommended config: chunkSize=${chunkSize}, overlap=${overlap}`;
  const width = 62;
  const padded = title.padEnd(width - 2);

  console.log(`\n╔${"═".repeat(width)}╗`);
  console.log(`║  ${padded}  ║`);
  console.log(`╚${"═".repeat(width)}╝`);

  console.log(`
  Why this cell won:
  • Highest overall score (${overallScore.toFixed(3)}) across all ${result.cells.length} configs
  • Faithfulness ${dimensionAverages.faithfulness.toFixed(3)} — retrieved chunks stayed on-topic
  • Context Recall ${dimensionAverages.contextRecall.toFixed(3)} — expected claims appeared in retrieved chunks
  • Context Precision ${dimensionAverages.contextPrecision.toFixed(3)} — most useful chunks ranked first

  To read the scorecard:
  • Low faithfulness across the grid → chunks are off-topic → try smaller chunkSize
  • Low recall across the grid → claims split across chunk boundaries → try higher overlap
  • Low precision across the grid → relevant chunks not ranked first → try smaller chunkSize or add a reranker

⚠  The DB now contains the last sweep config (chunkSize=1024, overlap=100).
   Run \`pnpm pipeline:ingest\` to restore your chosen config.`);
}

async function main() {
  try {
    console.log("Extracting PDF to Markdown...");
    const { markdown, cached } = await extractToMarkdown(
      DEFAULT_PDF_PATH,
      DEFAULT_PRODUCT_ID,
    );
    console.log(`  Extraction: ${cached ? "using cache" : "fresh via Gemini"}`);

    console.log("Getting eval set (cached or generating)...");
    const evalSet = await getOrGenerateEvalSet(markdown, DEFAULT_PRODUCT_ID);
    console.log(`  Eval set: ${evalSet.items.length} golden Q&A pairs`);

    console.log("Connecting to MongoDB...");
    const db = await getDb();

    console.log(
      "\nRunning grid sweep (9 configs × eval set — this takes 10–20 min)...",
    );
    const result = await runSweep({
      markdown,
      evalSet: evalSet.items,
      productId: DEFAULT_PRODUCT_ID,
      db,
      verbose: true,
    });

    printWinnerBox(result);

    // Save sweep summary
    if (!existsSync(REPORT_DIR)) {
      mkdirSync(REPORT_DIR, { recursive: true });
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const summaryPath = resolve(
      REPORT_DIR,
      `sweep-${DEFAULT_PRODUCT_ID}-${timestamp}.json`,
    );
    const summary = {
      timestamp: new Date().toISOString(),
      productId: DEFAULT_PRODUCT_ID,
      winner: {
        chunkSize: result.winner.config.chunkSize,
        overlap: result.winner.config.overlap,
        overallScore: result.winner.report.overallScore,
        passRate: result.winner.report.passRate,
        dimensionAverages: result.winner.report.dimensionAverages,
      },
      cells: result.cells.map((c) => ({
        chunkSize: c.config.chunkSize,
        overlap: c.config.overlap,
        overallScore: c.report.overallScore,
        passRate: c.report.passRate,
        dimensionAverages: c.report.dimensionAverages,
      })),
    };
    writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf-8");
    console.log(`\n  Sweep summary saved: ${summaryPath}`);

    process.exit(0);
  } catch (error) {
    console.error("Sweep failed:", error);
    process.exit(1);
  }
}

main();
