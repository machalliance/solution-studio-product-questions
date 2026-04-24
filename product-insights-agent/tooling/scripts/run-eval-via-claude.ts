/**
 * Runs the ingestion eval pipeline using the Claude CLI (`claude -p`)
 * as the LLM backend instead of direct Anthropic API calls.
 *
 * This lets you use your Claude Code subscription for the eval loop
 * without needing a separate ANTHROPIC_API_KEY.
 *
 * Usage: pnpm eval:via-claude [--regenerate-eval-set]
 */

import { execSync } from "child_process";
import { resolve } from "path";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { extractToMarkdown } from "../pipeline/extract-markdown";
import { chunkMarkdown, DEFAULT_CHUNK_CONFIG } from "../pipeline/chunk";
import { enrichChunks } from "../pipeline/metadata";
import {
  computeSecondaryScores,
  aggregateResults,
  DEFAULT_THRESHOLDS,
  type JudgmentResult,
  type Judgment,
  type ContextRecallResult,
  type ContextPrecisionResult,
} from "../pipeline/judge";
import { similaritySearch } from "@/server/db/vectors";
import { getDb } from "@/server/db/client";
import type { GoldenQA, EvalSet } from "../pipeline/eval-set";

const PDF_PATH = resolve(
  __dirname,
  "../../data/example-product-pdf.pdf",
);
const PRODUCT_ID = "dreame-x40-ultra";
const EVAL_SET_PATH = resolve(
  __dirname,
  "../../data/eval-sets/dreame-x40-ultra.json",
);
const REPORT_DIR = resolve(__dirname, "../../data/eval-reports");

/**
 * Calls `claude -p` with a prompt and JSON schema, returning parsed JSON.
 * Uses sonnet model to keep costs down for eval workloads.
 */
function callClaude<T>(prompt: string, jsonSchema: object): T {
  const schemaStr = JSON.stringify(jsonSchema);
  const result = execSync(
    `claude -p --model sonnet --output-format json --json-schema '${schemaStr.replace(/'/g, "'\\''")}'`,
    {
      input: prompt,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 180_000,
    },
  );

  const parsed = JSON.parse(result);
  // claude -p --output-format json returns { structured_output: T, result: string, ... }
  if (parsed.structured_output) {
    return parsed.structured_output as T;
  }
  // Fallback: try parsing the result string
  if (parsed.result && typeof parsed.result === "string") {
    try {
      return JSON.parse(parsed.result) as T;
    } catch {
      // result might not be JSON
    }
  }
  throw new Error(
    `Claude CLI returned unexpected format: ${JSON.stringify(parsed).substring(0, 200)}`,
  );
}

/**
 * Generates golden Q&A eval set using claude CLI.
 */
function generateEvalSet(fullText: string): EvalSet {
  console.log("Generating golden Q&A eval set via Claude CLI...");

  const schema = {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            question: {
              type: "string",
              description: "A natural question a shopper would ask",
            },
            answer: {
              type: "string",
              description:
                "The expected answer derived from the product manual",
            },
            sourcePassage: {
              type: "string",
              description:
                "The exact passage from the manual that supports this answer",
            },
            topic: {
              type: "string",
              description:
                "Topic category: safety, setup, usage, maintenance, troubleshooting, specifications, package-contents, or general",
            },
            claims: {
              type: "array",
              items: { type: "string" },
              description:
                "Atomic factual claims the answer contains — each independently verifiable",
            },
            relevantSections: {
              type: "array",
              items: { type: "string" },
              description:
                "Markdown heading texts from the source that contain relevant information",
            },
          },
          required: [
            "question",
            "answer",
            "sourcePassage",
            "topic",
            "claims",
            "relevantSections",
          ],
        },
      },
    },
    required: ["items"],
  };

  const prompt = `You are an evaluation set generator for a product question-answering system.

Given the following product manual text, generate 25 golden question-answer pairs that a real shopper would ask about this product.

Requirements:
- Generate exactly 25 Q&A pairs
- Cover diverse topics: safety, setup, usage, maintenance, troubleshooting, specifications, package-contents
- Questions should be natural and varied — some simple ("What's in the box?"), some detailed ("How do I clean the HEPA filter?"), some comparative ("Can it handle carpet and hard floors?")
- Each answer must be directly derivable from the manual text
- Each sourcePassage must be the verbatim or near-verbatim text from the manual that supports the answer
- Ensure good coverage across different sections of the manual
- Include at least 2 questions per major topic area

For each Q&A pair, also provide:
- **claims**: Break the answer into atomic factual claims — individual facts that can each be independently verified against the source document. Each claim should be a single, self-contained statement. Aim for 2-8 claims per answer.
- **relevantSections**: List the Markdown heading texts from the manual that contain information relevant to this question. Use the exact heading text as it appears in the document.

Product manual text:
${fullText}`;

  const result = callClaude<{ items: GoldenQA[] }>(prompt, schema);

  const evalSet: EvalSet = {
    productId: PRODUCT_ID,
    generatedAt: new Date().toISOString(),
    model: "claude-cli",
    items: result.items,
  };

  console.log(`  Generated ${evalSet.items.length} Q&A pairs`);
  return evalSet;
}

/**
 * Judges context recall for a single Q&A pair using claude CLI.
 */
function judgeContextRecallViaClaude(
  qa: GoldenQA,
  retrievedChunks: { text: string; score: number }[],
): ContextRecallResult {
  const claims = qa.claims ?? [];
  if (claims.length === 0) {
    return { claimAttributions: [], score: 1 };
  }

  const combinedRetrieved = retrievedChunks
    .map((c, i) => `[Chunk ${i + 1}]: ${c.text}`)
    .join("\n\n");

  const schema = {
    type: "object",
    properties: {
      claimAttributions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            claim: { type: "string" },
            attributed: { type: "boolean" },
            chunkIndex: { type: ["number", "null"] },
            reasoning: { type: "string" },
          },
          required: ["claim", "attributed", "chunkIndex", "reasoning"],
        },
      },
    },
    required: ["claimAttributions"],
  };

  const prompt = `You are evaluating the recall of a retrieval system. Given a list of factual claims, determine whether each claim can be attributed to any of the retrieved chunks.

**Claims to verify:**
${claims.map((c, i) => `${i + 1}. ${c}`).join("\n")}

**Retrieved chunks:**
${combinedRetrieved}

For each claim, determine:
- attributed: true if the claim's information is present in any chunk
- chunkIndex: the 1-based index of the supporting chunk, or null if not found`;

  const result = callClaude<{
    claimAttributions: ContextRecallResult["claimAttributions"];
  }>(prompt, schema);

  const attributedCount = result.claimAttributions.filter(
    (a) => a.attributed,
  ).length;
  const score =
    claims.length > 0
      ? Math.round((attributedCount / claims.length) * 1000) / 1000
      : 1;

  return { claimAttributions: result.claimAttributions, score };
}

/**
 * Judges context precision for a single Q&A pair using claude CLI.
 */
function judgeContextPrecisionViaClaude(
  qa: GoldenQA,
  retrievedChunks: { text: string; score: number }[],
): ContextPrecisionResult {
  if (retrievedChunks.length === 0) {
    return { chunkVerdicts: [], score: 0 };
  }

  const combinedRetrieved = retrievedChunks
    .map((c, i) => `[Chunk ${i + 1}]: ${c.text}`)
    .join("\n\n");

  const schema = {
    type: "object",
    properties: {
      chunkVerdicts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            chunkIndex: { type: "number" },
            useful: { type: "boolean" },
            reasoning: { type: "string" },
          },
          required: ["chunkIndex", "useful", "reasoning"],
        },
      },
    },
    required: ["chunkVerdicts"],
  };

  const prompt = `You are evaluating the precision of a retrieval system. Chunks are in retrieval rank order (Chunk 1 = highest).

For each chunk, determine whether it is useful for answering the question.

**Question:** ${qa.question}
**Expected answer:** ${qa.answer}

**Retrieved chunks (in rank order):**
${combinedRetrieved}`;

  const result = callClaude<{
    chunkVerdicts: ContextPrecisionResult["chunkVerdicts"];
  }>(prompt, schema);

  // Weighted precision@k
  const verdicts = result.chunkVerdicts;
  let relevantSoFar = 0;
  let weightedSum = 0;
  const totalRelevant = verdicts.filter((v) => v.useful).length;

  for (let k = 0; k < verdicts.length; k++) {
    if (verdicts[k].useful) {
      relevantSoFar++;
      weightedSum += relevantSoFar / (k + 1);
    }
  }

  const score =
    totalRelevant > 0
      ? Math.round((weightedSum / totalRelevant) * 1000) / 1000
      : 0;

  return { chunkVerdicts: verdicts, score };
}

/**
 * Judges faithfulness using claude CLI.
 */
function judgeFaithfulnessViaClaude(
  qa: GoldenQA,
  retrievedChunks: { text: string }[],
): { score: number; reasoning: string } {
  const combinedRetrieved = retrievedChunks
    .map((c, i) => `[Chunk ${i + 1}]: ${c.text}`)
    .join("\n\n");

  const schema = {
    type: "object",
    properties: {
      score: { type: "number" },
      reasoning: { type: "string" },
    },
    required: ["score", "reasoning"],
  };

  const prompt = `Score whether the retrieved chunks are relevant to the question from 0.0 to 1.0.
- 1.0 = All chunks on-topic and directly relevant
- 0.5 = Some relevant, some off-topic
- 0.0 = Completely unrelated

**Question:** ${qa.question}
**Expected answer:** ${qa.answer}
**Source passage:** ${qa.sourcePassage}

**Retrieved chunks:**
${combinedRetrieved}`;

  return callClaude<{ score: number; reasoning: string }>(prompt, schema);
}

/**
 * Judges retrieval quality for a single Q&A pair using 3 per-metric judges via claude CLI.
 */
function judgeRetrieval(
  qa: GoldenQA,
  retrievedChunks: { text: string; score: number }[],
): JudgmentResult {
  const round = (n: number) => Math.round(n * 1000) / 1000;

  // Run judges sequentially (CLI calls are synchronous)
  const faithfulnessResult = judgeFaithfulnessViaClaude(qa, retrievedChunks);
  const recallResult = judgeContextRecallViaClaude(qa, retrievedChunks);
  const precisionResult = judgeContextPrecisionViaClaude(qa, retrievedChunks);

  const judgment: Judgment = {
    faithfulness: {
      score: round(faithfulnessResult.score),
      reasoning: faithfulnessResult.reasoning,
    },
    contextRecall: {
      score: recallResult.score,
      reasoning: `${recallResult.claimAttributions.filter((a) => a.attributed).length}/${recallResult.claimAttributions.length} claims attributed`,
    },
    contextPrecision: {
      score: precisionResult.score,
      reasoning: `${precisionResult.chunkVerdicts.filter((v) => v.useful).length}/${precisionResult.chunkVerdicts.length} chunks useful`,
    },
  };

  const averageScore = round(
    (judgment.faithfulness.score +
      judgment.contextRecall.score +
      judgment.contextPrecision.score) /
      3,
  );

  return {
    question: qa.question,
    expectedAnswer: qa.answer,
    retrievedTexts: retrievedChunks.map((c) => c.text),
    judgment,
    averageScore,
    contextRecallDetail: recallResult,
    contextPrecisionDetail: precisionResult,
  };
}

async function main() {
  const regenerate = process.argv.includes("--regenerate-eval-set");

  console.log("=== Ingestion Eval via Claude CLI ===\n");

  // Step 1: Extract PDF to Markdown
  console.log("Extracting PDF to Markdown...");
  const { markdown, cached } = await extractToMarkdown(PDF_PATH, PRODUCT_ID);
  console.log(`  Extraction: ${cached ? "using cache" : "fresh via Gemini"}\n`);

  // Step 2: Get or generate eval set
  let evalSet: EvalSet;

  if (!regenerate && existsSync(EVAL_SET_PATH)) {
    const cached = JSON.parse(readFileSync(EVAL_SET_PATH, "utf-8")) as EvalSet;
    if (cached.items.length >= 10) {
      console.log(
        `Using cached eval set (${cached.items.length} items, generated ${cached.generatedAt})`,
      );
      evalSet = cached;
    } else {
      console.log(
        `Cached eval set only has ${cached.items.length} items, regenerating...`,
      );
      evalSet = generateEvalSet(markdown);
      writeFileSync(EVAL_SET_PATH, JSON.stringify(evalSet, null, 2), "utf-8");
    }
  } else {
    evalSet = generateEvalSet(markdown);
    const dir = resolve(EVAL_SET_PATH, "..");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(EVAL_SET_PATH, JSON.stringify(evalSet, null, 2), "utf-8");
  }

  console.log(`\nEval set: ${evalSet.items.length} golden Q&A pairs\n`);

  // Step 3: Judge each question against the vector store
  console.log("Connecting to MongoDB...");
  const db = await getDb();

  console.log("Judging retrieval quality (3 metrics per question)...\n");
  const results: JudgmentResult[] = [];

  for (let i = 0; i < evalSet.items.length; i++) {
    const qa = evalSet.items[i];
    const shortQ = qa.question.substring(0, 60);
    console.log(`  [${i + 1}/${evalSet.items.length}] "${shortQ}..."`);

    const retrievedChunks = await similaritySearch(db, qa.question, {
      productId: PRODUCT_ID,
      topK: 5,
      minScore: 0.3,
    });

    console.log(`    Retrieved ${retrievedChunks.length} chunks`);

    const result = judgeRetrieval(qa, retrievedChunks);
    const j = result.judgment;
    console.log(
      `    Faithfulness=${j.faithfulness.score} Recall=${j.contextRecall.score} Precision=${j.contextPrecision.score} → avg=${result.averageScore}`,
    );

    // Log missed claims
    if (result.contextRecallDetail?.claimAttributions.length) {
      const missed = result.contextRecallDetail.claimAttributions.filter(
        (a) => !a.attributed,
      );
      for (const m of missed) {
        console.log(`      ✗ "${m.claim.substring(0, 80)}"`);
      }
    }

    results.push(result);
  }

  // Step 4: Secondary scores
  console.log("\nComputing secondary scores...");
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
    PRODUCT_ID,
    DEFAULT_THRESHOLDS,
  );

  if (!existsSync(REPORT_DIR)) mkdirSync(REPORT_DIR, { recursive: true });
  const filename = `ingestion-eval-${PRODUCT_ID}-${report.timestamp.replace(/[:.]/g, "-")}.json`;
  const reportPath = resolve(REPORT_DIR, filename);
  writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf-8");

  console.log("\n=== Ingestion Eval Results ===");
  console.log(`  Overall score: ${report.overallScore.toFixed(3)}`);
  console.log(`  Pass rate: ${(report.passRate * 100).toFixed(1)}%`);
  console.log(
    `  Faithfulness: ${report.dimensionAverages.faithfulness.toFixed(3)}`,
  );
  console.log(
    `  Context Recall: ${report.dimensionAverages.contextRecall.toFixed(3)}`,
  );
  console.log(
    `  Context Precision: ${report.dimensionAverages.contextPrecision.toFixed(3)}`,
  );
  console.log(`  Secondary scores:`);
  console.log(
    `    Chunk size distribution: ${secondaryScores.chunkSizeDistribution.score}`,
  );
  console.log(`    Deduplication: ${secondaryScores.deduplication.score}`);
  console.log(`    Metadata quality: ${secondaryScores.metadataQuality.score}`);
  console.log(`    Section coverage: ${secondaryScores.sectionCoverage.score}`);
  console.log(`  Passed: ${report.passed ? "YES ✓" : "NO ✗"}`);
  console.log(`  Report: ${reportPath}`);

  process.exit(report.passed ? 0 : 1);
}

main().catch((err) => {
  console.error("Eval failed:", err);
  process.exit(1);
});
