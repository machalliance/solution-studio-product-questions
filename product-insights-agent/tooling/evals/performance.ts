import { resolve } from "path";
import { generateText } from "ai";
import { extractToMarkdown } from "../pipeline/extract-markdown";
import { getOrGenerateEvalSet } from "../pipeline/eval-set";
import { retrieveChunks } from "@/server/retrieval";
import { buildSystemPrompt, buildUserMessage } from "@/server/prompt";
import { FileProductDataAdapter } from "@/server/product/file-adapter";
import { generateEmbeddings } from "@/server/db/vectors";
import { writeFileSync, mkdirSync, existsSync } from "fs";

const DEFAULT_PDF_PATH = resolve(
  __dirname,
  "../../data/example-product-pdf.pdf",
);
const DEFAULT_PRODUCT_ID = "dreame-x40-ultra";
const REPORT_DIR = resolve(__dirname, "../../data/eval-reports");
const CHAT_MODEL = "openai/gpt-5-mini";

// --- Performance types ---

export interface LatencyMeasurement {
  question: string;
  type: "simple" | "complex";
  retrievalMs: number;
  generationMs: number;
  totalMs: number;
}

export interface EmbeddingBenchmark {
  textCount: number;
  totalMs: number;
  avgMsPerText: number;
}

export interface PerformanceReport {
  productId: string;
  timestamp: string;
  model: string;
  latency: {
    simple: LatencyStats;
    complex: LatencyStats;
  };
  embedding: EmbeddingBenchmark;
  measurements: LatencyMeasurement[];
}

export interface LatencyStats {
  count: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
}

export interface PerformanceEvalOptions {
  pdfPath?: string;
  productId?: string;
  verbose?: boolean;
}

/**
 * Classifies a question as simple (single-chunk) or complex (multi-chunk).
 * Simple questions are direct fact lookups; complex questions require synthesizing multiple sources.
 */
export function classifyQuestionComplexity(
  question: string,
): "simple" | "complex" {
  const complexIndicators = [
    /compare/i,
    /difference/i,
    /how does .+ work/i,
    /explain/i,
    /what are .+ features/i,
    /overview/i,
    /steps/i,
    /process/i,
    /all .+ (modes?|settings?|options?)/i,
  ];

  return complexIndicators.some((p) => p.test(question)) ? "complex" : "simple";
}

/**
 * Measures latency for a single question through the RAG pipeline.
 */
async function measureLatency(
  question: string,
  productId: string,
): Promise<LatencyMeasurement> {
  const productAdapter = new FileProductDataAdapter();
  const product = await productAdapter.getProduct(productId);

  // Measure retrieval
  const retrievalStart = performance.now();
  const chunks = await retrieveChunks(question, { productId });
  const retrievalMs = performance.now() - retrievalStart;

  // Measure generation
  const systemPrompt = await buildSystemPrompt(product);
  const contextMessage = buildUserMessage(product, chunks, question);

  const generationStart = performance.now();
  await generateText({
    model: CHAT_MODEL,
    system: systemPrompt,
    messages: [{ role: "user", content: contextMessage }],
  });
  const generationMs = performance.now() - generationStart;

  const totalMs = retrievalMs + generationMs;
  const type = classifyQuestionComplexity(question);

  return {
    question,
    type,
    retrievalMs: Math.round(retrievalMs),
    generationMs: Math.round(generationMs),
    totalMs: Math.round(totalMs),
  };
}

/**
 * Benchmarks embedding generation throughput.
 */
async function measureEmbeddingThroughput(
  texts: string[],
): Promise<EmbeddingBenchmark> {
  const start = performance.now();
  await generateEmbeddings(texts);
  const totalMs = performance.now() - start;

  return {
    textCount: texts.length,
    totalMs: Math.round(totalMs),
    avgMsPerText: Math.round(totalMs / texts.length),
  };
}

/**
 * Computes latency statistics from a set of measurements.
 */
export function computeLatencyStats(
  measurements: LatencyMeasurement[],
): LatencyStats {
  if (measurements.length === 0) {
    return { count: 0, avgMs: 0, minMs: 0, maxMs: 0, p50Ms: 0, p95Ms: 0 };
  }

  const totals = measurements.map((m) => m.totalMs).sort((a, b) => a - b);
  const count = totals.length;
  const avgMs = Math.round(totals.reduce((a, b) => a + b, 0) / count);
  const minMs = totals[0];
  const maxMs = totals[count - 1];
  const p50Ms = totals[Math.floor(count * 0.5)];
  const p95Ms = totals[Math.floor(count * 0.95)];

  return { count, avgMs, minMs, maxMs, p50Ms, p95Ms };
}

/**
 * Runs the performance eval suite (Suite 5).
 *
 * Benchmarks:
 * 1. Response latency for simple (single-chunk) questions
 * 2. Response latency for complex (multi-chunk) questions
 * 3. Embedding generation throughput
 */
export async function runPerformanceEval(
  options: PerformanceEvalOptions = {},
): Promise<PerformanceReport> {
  const {
    pdfPath = DEFAULT_PDF_PATH,
    productId = DEFAULT_PRODUCT_ID,
    verbose = false,
  } = options;

  const log = (msg: string) => {
    if (verbose) console.log(msg);
  };

  // Step 1: Get golden Q&A pairs as test questions
  log("Extracting PDF to Markdown...");
  const { markdown } = await extractToMarkdown(pdfPath, productId);

  log("Getting eval set (cached or generating)...");
  const evalSet = await getOrGenerateEvalSet(markdown, productId);
  log(`  Using ${evalSet.items.length} test questions`);

  // Step 2: Measure latency for each question
  log("Measuring response latency...");
  const measurements: LatencyMeasurement[] = [];

  for (const qa of evalSet.items) {
    log(`  Timing: "${qa.question.substring(0, 60)}..."`);
    const measurement = await measureLatency(qa.question, productId);
    measurements.push(measurement);
    log(
      `    ${measurement.type} — retrieval: ${measurement.retrievalMs}ms, generation: ${measurement.generationMs}ms, total: ${measurement.totalMs}ms`,
    );
  }

  // Step 3: Benchmark embedding throughput
  log("Benchmarking embedding throughput...");
  const sampleTexts = evalSet.items.map((qa) => qa.question);
  const embeddingBenchmark = await measureEmbeddingThroughput(sampleTexts);
  log(
    `  ${embeddingBenchmark.textCount} texts in ${embeddingBenchmark.totalMs}ms (${embeddingBenchmark.avgMsPerText}ms avg)`,
  );

  // Step 4: Compute stats by question type
  const simpleMeasurements = measurements.filter((m) => m.type === "simple");
  const complexMeasurements = measurements.filter((m) => m.type === "complex");

  const report: PerformanceReport = {
    productId,
    timestamp: new Date().toISOString(),
    model: CHAT_MODEL,
    latency: {
      simple: computeLatencyStats(simpleMeasurements),
      complex: computeLatencyStats(complexMeasurements),
    },
    embedding: embeddingBenchmark,
    measurements,
  };

  // Step 5: Save report
  if (!existsSync(REPORT_DIR)) {
    mkdirSync(REPORT_DIR, { recursive: true });
  }
  const filename = `performance-eval-${productId}-${report.timestamp.replace(/[:.]/g, "-")}.json`;
  const reportPath = resolve(REPORT_DIR, filename);
  writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf-8");

  log(`\n--- Performance Eval Results ---`);
  log(`  Model: ${report.model}`);
  log(
    `  Simple questions: ${report.latency.simple.count} — avg ${report.latency.simple.avgMs}ms, p50 ${report.latency.simple.p50Ms}ms, p95 ${report.latency.simple.p95Ms}ms`,
  );
  log(
    `  Complex questions: ${report.latency.complex.count} — avg ${report.latency.complex.avgMs}ms, p50 ${report.latency.complex.p50Ms}ms, p95 ${report.latency.complex.p95Ms}ms`,
  );
  log(
    `  Embedding throughput: ${report.embedding.avgMsPerText}ms/text (${report.embedding.textCount} texts)`,
  );
  log(`  Report saved: ${reportPath}`);

  return report;
}

// CLI entry point
async function main() {
  const verbose = process.argv.includes("--verbose") || true;

  try {
    await runPerformanceEval({ verbose });
    process.exit(0);
  } catch (error) {
    console.error("Performance eval failed:", error);
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
