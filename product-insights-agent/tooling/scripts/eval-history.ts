/**
 * Displays eval history — shows how scores have changed across runs.
 *
 * This is a local alternative to tools like LangSmith for tracking
 * eval quality over time. It reads all eval reports from data/eval-reports/
 * and presents a comparison table.
 *
 * Backward compatible: older reports with retrievalRelevance/informationCompleteness
 * display correctly alongside newer reports with faithfulness/contextRecall/contextPrecision.
 *
 * Usage:
 *   pnpm eval:history                  # show all runs
 *   pnpm eval:history -- --last 5      # show last 5 runs
 *   pnpm eval:history -- --detail      # show per-question breakdown
 */

import { readdirSync, readFileSync } from "fs";
import { resolve } from "path";
import type { EvalReport } from "../pipeline/judge";

const REPORT_DIR = resolve(__dirname, "../../data/eval-reports");

interface ParsedReport {
  filename: string;
  report: EvalReport;
}

/** Check whether a report uses the current metric names (faithfulness, not retrievalRelevance) */
function isNewFormat(report: EvalReport): boolean {
  return "faithfulness" in report.dimensionAverages;
}

function loadReports(): ParsedReport[] {
  const files = readdirSync(REPORT_DIR)
    .filter((f) => f.startsWith("ingestion-eval-") && f.endsWith(".json"))
    .sort();

  return files.map((filename) => {
    const raw = readFileSync(resolve(REPORT_DIR, filename), "utf-8");
    return { filename, report: JSON.parse(raw) as EvalReport };
  });
}

function formatScore(score: number | undefined): string {
  if (score === undefined) return " n/a ";
  return score.toFixed(3);
}

function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function delta(
  current: number | undefined,
  previous: number | undefined,
): string {
  if (current === undefined || previous === undefined) return "  -  ";
  const diff = current - previous;
  if (Math.abs(diff) < 0.001) return "  =  ";
  const sign = diff > 0 ? "+" : "";
  const arrow = diff > 0 ? " ^" : " v";
  return `${sign}${diff.toFixed(3)}${arrow}`;
}

/** Get metric value supporting both old and new report formats */
function getMetric(
  report: EvalReport,
  name: "faithfulness" | "contextRecall" | "contextPrecision",
): number | undefined {
  const dims = report.dimensionAverages as Record<string, number>;

  if (name === "faithfulness") {
    // New format: faithfulness; old format: retrievalRelevance
    return dims.faithfulness ?? dims.retrievalRelevance;
  }

  if (name === "contextRecall") {
    // New format only — old format had informationCompleteness (different metric)
    return dims.contextRecall;
  }

  if (name === "contextPrecision") {
    // New format only
    return dims.contextPrecision;
  }

  return undefined;
}

function printSummaryTable(reports: ParsedReport[]) {
  console.log("=== Eval History ===\n");
  console.log(`Found ${reports.length} eval run(s) in data/eval-reports/\n`);

  if (reports.length === 0) {
    console.log("No eval reports found. Run: pnpm eval:via-claude");
    return;
  }

  // Header
  const sep =
    "+---------+---------------------+--------+----------+-----------+--------+--------+--------+";
  console.log(sep);
  console.log(
    "| Run #   | Timestamp           | Passed | Overall  | Pass Rate | Faith. | Recall | Precis |",
  );
  console.log(sep);

  for (let i = 0; i < reports.length; i++) {
    const r = reports[i].report;
    const prev = i > 0 ? reports[i - 1].report : null;

    const run = String(i + 1).padStart(3);
    const ts = r.timestamp.replace("T", " ").substring(0, 19);
    const passed = r.passed ? " YES " : " NO  ";
    const overall = formatScore(r.overallScore).padStart(5);
    const passRate = formatPercent(r.passRate).padStart(6);
    const faith = formatScore(getMetric(r, "faithfulness")).padStart(5);
    const recall = formatScore(getMetric(r, "contextRecall")).padStart(5);
    const precision = formatScore(getMetric(r, "contextPrecision")).padStart(5);

    console.log(
      `|  ${run}    | ${ts} | ${passed}  | ${overall}   | ${passRate}    | ${faith}  | ${recall}  | ${precision}  |`,
    );

    if (prev) {
      const dOverall = delta(r.overallScore, prev.overallScore).padStart(8);
      const dFaith = delta(
        getMetric(r, "faithfulness"),
        getMetric(prev, "faithfulness"),
      ).padStart(8);
      const dRecall = delta(
        getMetric(r, "contextRecall"),
        getMetric(prev, "contextRecall"),
      ).padStart(8);
      const dPrecision = delta(
        getMetric(r, "contextPrecision"),
        getMetric(prev, "contextPrecision"),
      ).padStart(8);
      console.log(
        `|         |       (vs prev run) |        | ${dOverall} | ${delta(r.passRate, prev.passRate).padStart(9)} | ${dFaith}| ${dRecall}| ${dPrecision}|`,
      );
    }
  }
  console.log(sep);

  // Secondary scores from latest run
  const latest = reports[reports.length - 1].report;
  console.log("\nLatest run secondary scores:");
  console.log(
    `  Chunk size distribution: ${latest.secondaryScores.chunkSizeDistribution.score} — ${latest.secondaryScores.chunkSizeDistribution.reasoning}`,
  );
  console.log(
    `  Deduplication:           ${latest.secondaryScores.deduplication.score} — ${latest.secondaryScores.deduplication.reasoning}`,
  );
  console.log(
    `  Metadata quality:        ${latest.secondaryScores.metadataQuality.score} — ${latest.secondaryScores.metadataQuality.reasoning}`,
  );
  if (latest.secondaryScores.sectionCoverage) {
    console.log(
      `  Section coverage:        ${latest.secondaryScores.sectionCoverage.score} — ${latest.secondaryScores.sectionCoverage.reasoning}`,
    );
  }
  if (latest.secondaryScores.sentenceCompleteness) {
    console.log(
      `  Sentence completeness:   ${latest.secondaryScores.sentenceCompleteness.score} — ${latest.secondaryScores.sentenceCompleteness.reasoning}`,
    );
  }
  if (latest.secondaryScores.structuralIntegrity) {
    console.log(
      `  Structural integrity:    ${latest.secondaryScores.structuralIntegrity.score} — ${latest.secondaryScores.structuralIntegrity.reasoning}`,
    );
  }

  console.log("\nThresholds:");
  console.log(
    `  Per-question: ${latest.thresholds.perQuestion}  |  Overall: ${latest.thresholds.overall}  |  Pass rate: ${formatPercent(latest.thresholds.passRate)}`,
  );
}

function printDetailTable(reports: ParsedReport[]) {
  const latest = reports[reports.length - 1];
  const isNew = isNewFormat(latest.report);

  console.log("\n=== Per-Question Detail (Latest Run) ===\n");

  if (isNew) {
    const sep =
      "+----+--------+-------+-------+-------+-------+----------------------------------------------------------+";
    console.log(sep);
    console.log(
      "| #  | Status | Avg   | Faith | Recall| Prec  | Question                                                 |",
    );
    console.log(sep);

    for (let i = 0; i < latest.report.results.length; i++) {
      const q = latest.report.results[i];
      const j = q.judgment;
      const status =
        q.averageScore >= latest.report.thresholds.perQuestion
          ? "PASS"
          : "FAIL";
      const num = String(i + 1).padStart(2);
      const avg = formatScore(q.averageScore);
      const faith = formatScore(j.faithfulness.score);
      const recall = formatScore(j.contextRecall.score);
      const prec = formatScore(j.contextPrecision.score);
      const question = q.question.substring(0, 56).padEnd(56);

      console.log(
        `| ${num} | ${status}   | ${avg} | ${faith} | ${recall} | ${prec} | ${question} |`,
      );

      // Show missing claims for context recall
      if (q.contextRecallDetail?.claimAttributions.length) {
        const missed = q.contextRecallDetail.claimAttributions.filter(
          (a) => !a.attributed,
        );
        for (const m of missed) {
          const claimText = m.claim.substring(0, 65).padEnd(65);
          console.log(
            `|    |        |       |       |       |       |   ✗ ${claimText} |`,
          );
        }
      }
    }
    console.log(sep);
  } else {
    // Legacy format
    const sep =
      "+----+--------+-------+-------+-------+-------+----------------------------------------------------------+";
    console.log(sep);
    console.log(
      "| #  | Status | Avg   | Coher | Relev | Compl | Question                                                 |",
    );
    console.log(sep);

    for (let i = 0; i < latest.report.results.length; i++) {
      const q = latest.report.results[i];
      const j = q.judgment as Record<string, { score: number }>;
      const status =
        q.averageScore >= latest.report.thresholds.perQuestion
          ? "PASS"
          : "FAIL";
      const num = String(i + 1).padStart(2);
      const avg = formatScore(q.averageScore);
      const coh = formatScore(j.coherence?.score);
      const rel = formatScore(j.retrievalRelevance?.score);
      const comp = formatScore(j.informationCompleteness?.score);
      const question = q.question.substring(0, 56).padEnd(56);

      console.log(
        `| ${num} | ${status}   | ${avg} | ${coh} | ${rel} | ${comp} | ${question} |`,
      );
    }
    console.log(sep);
  }
}

function main() {
  const args = process.argv.slice(2);
  const showDetail = args.includes("--detail");
  const lastIdx = args.indexOf("--last");
  const lastN = lastIdx >= 0 ? parseInt(args[lastIdx + 1], 10) : undefined;

  let reports = loadReports();

  if (lastN && lastN > 0) {
    reports = reports.slice(-lastN);
  }

  printSummaryTable(reports);

  if (showDetail && reports.length > 0) {
    printDetailTable(reports);
  }

  if (!showDetail && reports.length > 0) {
    console.log("\nTip: run with --detail to see per-question breakdown");
  }
}

main();
