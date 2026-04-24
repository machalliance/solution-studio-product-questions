import { resolve } from "path";
import { Output, generateText } from "ai";
import { z } from "zod";
import { extractToMarkdown } from "../pipeline/extract-markdown";
import { getOrGenerateEvalSet } from "../pipeline/eval-set";
import { retrieveChunks } from "@/server/retrieval";
import { buildSystemPrompt, buildUserMessage } from "@/server/prompt";
import { FileProductDataAdapter } from "@/server/product/file-adapter";
import { writeFileSync, mkdirSync, existsSync } from "fs";

const DEFAULT_PDF_PATH = resolve(
  __dirname,
  "../../data/example-product-pdf.pdf",
);
const DEFAULT_PRODUCT_ID = "dreame-x40-ultra";
const REPORT_DIR = resolve(__dirname, "../../data/eval-reports");
const CHAT_MODEL = "openai/gpt-5-mini";

// --- Quality score schemas ---

const qualityDimensionSchema = z.object({
  score: z
    .number()
    .describe("Score from 0 to 1, where 1 is perfect and 0 is complete fail"),
  reasoning: z
    .string()
    .describe("Brief explanation of the score, one sentence"),
});

const qualityJudgmentSchema = z.object({
  grounding: qualityDimensionSchema.describe(
    "Is the answer grounded in the provided product data and PDF content? Does it avoid hallucinations?",
  ),
  retrievalRelevance: qualityDimensionSchema.describe(
    "Were the correct, most relevant chunks retrieved for this question?",
  ),
  tone: qualityDimensionSchema.describe(
    "Is the response helpful, concise, and brand-appropriate? Does it use a professional, friendly tone?",
  ),
  lengthCompliance: qualityDimensionSchema.describe(
    "Is the response an appropriate length — not too short to be unhelpful, not too long to be overwhelming?",
  ),
});

export type QualityJudgment = z.infer<typeof qualityJudgmentSchema>;

export interface QualityTestCase {
  question: string;
  expectedAnswer: string;
  sourcePassage: string;
}

export interface QualityResult {
  question: string;
  answer: string;
  retrievedChunkCount: number;
  judgment: QualityJudgment;
  averageScore: number;
}

export interface QualityReport {
  productId: string;
  timestamp: string;
  model: string;
  totalQuestions: number;
  passedQuestions: number;
  passRate: number;
  overallScore: number;
  dimensionAverages: {
    grounding: number;
    retrievalRelevance: number;
    tone: number;
    lengthCompliance: number;
  };
  thresholds: QualityThresholds;
  passed: boolean;
  results: QualityResult[];
}

export interface QualityThresholds {
  perQuestion: number;
  overall: number;
  passRate: number;
}

export const DEFAULT_QUALITY_THRESHOLDS: QualityThresholds = {
  perQuestion: 0.6,
  overall: 0.7,
  passRate: 0.8,
};

export interface QualityEvalOptions {
  pdfPath?: string;
  productId?: string;
  thresholds?: QualityThresholds;
  verbose?: boolean;
}

/**
 * Generates a full answer from the RAG pipeline for a given question.
 * Mimics the /api/chat flow: retrieve chunks → build prompt → generate response.
 */
async function generateAnswer(
  question: string,
  productId: string,
): Promise<{ answer: string; chunkCount: number }> {
  const productAdapter = new FileProductDataAdapter();
  const product = await productAdapter.getProduct(productId);
  const chunks = await retrieveChunks(question, { productId });
  const systemPrompt = await buildSystemPrompt(product);
  const contextMessage = buildUserMessage(product, chunks, question);

  const { text } = await generateText({
    model: CHAT_MODEL,
    system: systemPrompt,
    messages: [{ role: "user", content: contextMessage }],
  });

  return { answer: text, chunkCount: chunks.length };
}

/**
 * Uses an LLM judge to score a generated answer against its expected answer and source.
 */
async function judgeQuality(
  question: string,
  generatedAnswer: string,
  expectedAnswer: string,
  sourcePassage: string,
): Promise<QualityJudgment> {
  const { output } = await generateText({
    model: "anthropic/claude-sonnet-4-5",
    output: Output.object({
      name: "QualityJudgment",
      description:
        "Quality judgment of a RAG-generated answer against expected answer and source",
      schema: qualityJudgmentSchema,
    }),
    prompt: `You are an evaluation judge for a RAG (retrieval-augmented generation) product Q&A system.

Given a customer question, the expected answer, the source passage from the product manual, and the AI-generated answer, score the answer quality on four dimensions.

Score each dimension from 0.0 to 1.0:
- 0.0 = complete failure
- 0.5 = partially adequate
- 1.0 = perfect

**Question:** ${question}

**Expected answer (from golden eval set):** ${expectedAnswer}

**Source passage from product manual:** ${sourcePassage}

**AI-generated answer:** ${generatedAnswer}

Score the answer on:
1. **Grounding** — Is the answer factually grounded in the product data and manual? Does it avoid making up information not present in the source material?
2. **Retrieval Relevance** — Does the answer draw from the correct source material? Is it addressing the right topic and using the right information from the manual?
3. **Tone** — Is the response helpful, concise, and professional? Does it use a friendly, brand-appropriate tone suitable for a product Q&A widget?
4. **Length Compliance** — Is the response an appropriate length? Too short (< 1 sentence) is unhelpful; too long (> 500 words) is overwhelming for a chat widget. Ideal is 2-5 sentences with bullet points where appropriate.`,
  });

  if (!output) {
    throw new Error(`LLM judge failed to score question: ${question}`);
  }

  return output;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Aggregates quality results into a report with pass/fail.
 */
export function aggregateQualityResults(
  results: QualityResult[],
  productId: string,
  thresholds: QualityThresholds = DEFAULT_QUALITY_THRESHOLDS,
): QualityReport {
  const totalQuestions = results.length;

  const passedQuestions = results.filter(
    (r) => r.averageScore >= thresholds.perQuestion,
  ).length;

  const passRate = totalQuestions > 0 ? passedQuestions / totalQuestions : 0;

  const overallScore =
    totalQuestions > 0
      ? round(
          results.reduce((sum, r) => sum + r.averageScore, 0) / totalQuestions,
        )
      : 0;

  const dimensionAverages = {
    grounding: round(
      results.reduce((sum, r) => sum + r.judgment.grounding.score, 0) /
        totalQuestions,
    ),
    retrievalRelevance: round(
      results.reduce((sum, r) => sum + r.judgment.retrievalRelevance.score, 0) /
        totalQuestions,
    ),
    tone: round(
      results.reduce((sum, r) => sum + r.judgment.tone.score, 0) /
        totalQuestions,
    ),
    lengthCompliance: round(
      results.reduce((sum, r) => sum + r.judgment.lengthCompliance.score, 0) /
        totalQuestions,
    ),
  };

  const passed =
    overallScore >= thresholds.overall && passRate >= thresholds.passRate;

  return {
    productId,
    timestamp: new Date().toISOString(),
    model: CHAT_MODEL,
    totalQuestions,
    passedQuestions,
    passRate: round(passRate),
    overallScore,
    dimensionAverages,
    thresholds,
    passed,
    results,
  };
}

/**
 * Runs the quality eval suite (Suite 3).
 *
 * For each golden Q&A pair:
 * 1. Sends the question through the full RAG pipeline (retrieve → prompt → generate)
 * 2. Uses an LLM judge to score the generated answer on grounding, retrieval, tone, length
 * 3. Aggregates scores into a pass/fail report
 */
export async function runQualityEval(
  options: QualityEvalOptions = {},
): Promise<QualityReport> {
  const {
    pdfPath = DEFAULT_PDF_PATH,
    productId = DEFAULT_PRODUCT_ID,
    thresholds = DEFAULT_QUALITY_THRESHOLDS,
    verbose = false,
  } = options;

  const log = (msg: string) => {
    if (verbose) console.log(msg);
  };

  // Step 1: Get or generate golden Q&A eval set
  log("Extracting PDF to Markdown...");
  const { markdown } = await extractToMarkdown(pdfPath, productId);

  log("Getting eval set (cached or generating)...");
  const evalSet = await getOrGenerateEvalSet(markdown, productId);
  log(`  Eval set: ${evalSet.items.length} golden Q&A pairs`);

  // Step 2: Generate answers and judge each
  log("Running RAG pipeline and judging quality...");
  const results: QualityResult[] = [];

  for (const qa of evalSet.items) {
    log(`  Evaluating: "${qa.question.substring(0, 60)}..."`);

    const { answer, chunkCount } = await generateAnswer(qa.question, productId);
    const judgment = await judgeQuality(
      qa.question,
      answer,
      qa.answer,
      qa.sourcePassage,
    );

    const averageScore = round(
      (judgment.grounding.score +
        judgment.retrievalRelevance.score +
        judgment.tone.score +
        judgment.lengthCompliance.score) /
        4,
    );

    results.push({
      question: qa.question,
      answer,
      retrievedChunkCount: chunkCount,
      judgment,
      averageScore,
    });
  }

  // Step 3: Aggregate and report
  const report = aggregateQualityResults(results, productId, thresholds);

  // Step 4: Save report
  if (!existsSync(REPORT_DIR)) {
    mkdirSync(REPORT_DIR, { recursive: true });
  }
  const filename = `quality-eval-${productId}-${report.timestamp.replace(/[:.]/g, "-")}.json`;
  const reportPath = resolve(REPORT_DIR, filename);
  writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf-8");

  log(`\n--- Quality Eval Results ---`);
  log(`  Model: ${report.model}`);
  log(`  Overall score: ${report.overallScore.toFixed(3)}`);
  log(`  Pass rate: ${(report.passRate * 100).toFixed(1)}%`);
  log(`  Grounding: ${report.dimensionAverages.grounding.toFixed(3)}`);
  log(
    `  Retrieval Relevance: ${report.dimensionAverages.retrievalRelevance.toFixed(3)}`,
  );
  log(`  Tone: ${report.dimensionAverages.tone.toFixed(3)}`);
  log(
    `  Length Compliance: ${report.dimensionAverages.lengthCompliance.toFixed(3)}`,
  );
  log(`  Passed: ${report.passed ? "YES" : "NO"}`);
  log(`  Report saved: ${reportPath}`);

  return report;
}

// CLI entry point
async function main() {
  const verbose = process.argv.includes("--verbose") || true;

  try {
    const report = await runQualityEval({ verbose });
    process.exit(report.passed ? 0 : 1);
  } catch (error) {
    console.error("Quality eval failed:", error);
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
