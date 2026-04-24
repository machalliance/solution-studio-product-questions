import { Output, generateText } from "ai";
import { z } from "zod";
import type { GoldenQA } from "./eval-set";
import type { SimilarityResult } from "@/server/db/vectors";
import type { EnrichedChunk } from "./metadata";

const PIPELINE_MODEL = "anthropic/claude-sonnet-4-5";

// --- Score schemas ---

export const dimensionScoreSchema = z.object({
  score: z
    .number()
    .describe("Score from 0 to 1, where 1 is perfect and 0 is complete fail"),
  reasoning: z
    .string()
    .describe("Brief explanation of the score, one sentence"),
});

export type DimensionScore = z.infer<typeof dimensionScoreSchema>;

// --- Context Recall types ---

export const claimAttributionSchema = z.object({
  claim: z.string().describe("The atomic factual claim being evaluated"),
  attributed: z
    .boolean()
    .describe("Whether this claim can be attributed to any retrieved chunk"),
  chunkIndex: z
    .number()
    .nullable()
    .describe(
      "The 1-based index of the chunk that supports this claim, or null if not found",
    ),
  reasoning: z
    .string()
    .describe("Brief explanation of the attribution decision"),
});

export type ClaimAttribution = z.infer<typeof claimAttributionSchema>;

export const contextRecallResultSchema = z.object({
  claimAttributions: z
    .array(claimAttributionSchema)
    .describe("Per-claim attribution results"),
});

export interface ContextRecallResult {
  claimAttributions: ClaimAttribution[];
  score: number;
}

// --- Context Precision types ---

export const chunkVerdictSchema = z.object({
  chunkIndex: z.number().describe("The 1-based index of the retrieved chunk"),
  useful: z
    .boolean()
    .describe("Whether this chunk is useful for answering the question"),
  reasoning: z.string().describe("Brief explanation of the verdict"),
});

export type ChunkVerdict = z.infer<typeof chunkVerdictSchema>;

export const contextPrecisionResultSchema = z.object({
  chunkVerdicts: z
    .array(chunkVerdictSchema)
    .describe("Per-chunk usefulness verdicts in rank order"),
});

export interface ContextPrecisionResult {
  chunkVerdicts: ChunkVerdict[];
  score: number;
}

// --- Combined judgment types ---

export const judgmentSchema = z.object({
  faithfulness: dimensionScoreSchema.describe(
    "Are the retrieved chunks relevant to and faithful to the question's topic?",
  ),
  contextRecall: dimensionScoreSchema.describe(
    "What fraction of expected claims are covered by retrieved chunks?",
  ),
  contextPrecision: dimensionScoreSchema.describe(
    "Are the most relevant chunks ranked highest?",
  ),
});

export type Judgment = z.infer<typeof judgmentSchema>;

export interface JudgmentResult {
  question: string;
  expectedAnswer: string;
  retrievedTexts: string[];
  judgment: Judgment;
  averageScore: number;
  contextRecallDetail?: ContextRecallResult;
  contextPrecisionDetail?: ContextPrecisionResult;
}

// --- Threshold configuration ---

export interface ScoreThresholds {
  /** Minimum average score across all dimensions for a single Q&A pair */
  perQuestion: number;
  /** Minimum average score across all Q&A pairs for the entire eval set */
  overall: number;
  /** Minimum pass rate — fraction of questions that meet perQuestion threshold */
  passRate: number;
}

export const DEFAULT_THRESHOLDS: ScoreThresholds = {
  perQuestion: 0.5,
  overall: 0.65,
  passRate: 0.8,
};

// --- Secondary scoring (deterministic, no LLM) ---

export interface SecondaryScores {
  chunkSizeDistribution: DimensionScore;
  deduplication: DimensionScore;
  metadataQuality: DimensionScore;
  sectionCoverage: DimensionScore;
  sentenceCompleteness: DimensionScore;
  structuralIntegrity: DimensionScore;
}

/**
 * Computes secondary quality scores deterministically from chunks.
 * These measure structural quality of the chunking, not answer quality.
 *
 * sectionCoverage requires judgmentResults to check whether retrieved chunks
 * came from the expected sections. Pass null/undefined to skip.
 */
export function computeSecondaryScores(
  chunks: EnrichedChunk[],
  judgmentResults?: JudgmentResult[],
  evalItems?: GoldenQA[],
): SecondaryScores {
  // Chunk size distribution: penalize high variance and extreme sizes
  const sizes = chunks.map((c) => c.text.length);
  const avgSize = sizes.reduce((a, b) => a + b, 0) / sizes.length;
  const variance =
    sizes.reduce((sum, s) => sum + Math.pow(s - avgSize, 2), 0) / sizes.length;
  const cv = Math.sqrt(variance) / avgSize; // coefficient of variation
  const sizeScore = Math.max(0, 1 - cv); // lower CV = better score

  // Deduplication: check for near-duplicate chunks (>80% text overlap)
  let duplicatePairs = 0;
  const totalPairs = (chunks.length * (chunks.length - 1)) / 2;
  for (let i = 0; i < chunks.length; i++) {
    for (let j = i + 1; j < chunks.length; j++) {
      if (textSimilarity(chunks[i].text, chunks[j].text) > 0.8) {
        duplicatePairs++;
      }
    }
  }
  const dedupScore = totalPairs > 0 ? 1 - duplicatePairs / totalPairs : 1;

  // Metadata quality: structural integrity of citation-carrying fields.
  // A chunk passes if it has page numbers AND a section header long enough to
  // be informative (catches parser failures that leave "", "1", or "—"). The
  // score is the fraction of chunks passing.
  const MIN_SECTION_HEADER_LENGTH = 3;
  let metadataPasses = 0;
  for (const chunk of chunks) {
    const m = chunk.metadata;
    const hasPages = m.pageNumbers.length > 0;
    const hasSection =
      m.sectionHeader.trim().length >= MIN_SECTION_HEADER_LENGTH;
    if (hasPages && hasSection) metadataPasses++;
  }
  const metadataScore = chunks.length > 0 ? metadataPasses / chunks.length : 1;

  // Section coverage: check if retrieved chunks come from expected sections
  let sectionCoverageScore = 0;
  let sectionCoverageReasoning = "Not computed — no eval results provided";

  if (judgmentResults && evalItems && evalItems.length > 0) {
    let questionsWithCoverage = 0;

    for (let i = 0; i < evalItems.length; i++) {
      const qa = evalItems[i];
      const result = judgmentResults[i];
      if (!qa.relevantSections?.length || !result) continue;

      const retrievedSections = result.retrievedTexts.map((text) => {
        // Try to extract section header from chunk text — chunks often start with or contain heading text
        // We match against the eval item's relevant sections using case-insensitive substring matching
        return text;
      });

      const hasMatch = qa.relevantSections.some((expectedSection) => {
        const normalizedExpected = expectedSection.toLowerCase().trim();
        return retrievedSections.some((retrievedText) =>
          retrievedText.toLowerCase().includes(normalizedExpected),
        );
      });

      if (hasMatch) questionsWithCoverage++;
    }

    const total = evalItems.filter((qa) => qa.relevantSections?.length).length;
    sectionCoverageScore = total > 0 ? questionsWithCoverage / total : 0;
    sectionCoverageReasoning = `${questionsWithCoverage}/${total} questions had at least one chunk from an expected section`;
  }

  // Sentence completeness: do chunks start/end on sentence boundaries?
  // A chunk is "sentence-complete" if it ends with sentence-ending punctuation
  // or a list marker (bullet points, table rows are valid endings).
  const sentenceEndPattern = /[.!?:)\]]\s*$|[|]\s*$/;
  const listOrTablePattern = /^\s*[*\-|]|^\s*\d+\./;
  let completeChunks = 0;
  for (const chunk of chunks) {
    const trimmed = chunk.text.trim();
    const endsCleanly =
      sentenceEndPattern.test(trimmed) || listOrTablePattern.test(trimmed);
    // Check if the chunk starts at a sentence or structural boundary
    const startsCleanly =
      /^[A-Z*\-|#\d]/.test(trimmed) || listOrTablePattern.test(trimmed);
    if (endsCleanly && startsCleanly) completeChunks++;
  }
  const sentenceCompletenessScore =
    chunks.length > 0 ? completeChunks / chunks.length : 1;

  // Structural integrity: are tables and lists kept intact within chunks?
  // A chunk with an incomplete table (odd number of | delimiters on a line,
  // or a table header without rows) or a truncated list is structurally broken.
  let intactChunks = 0;
  for (const chunk of chunks) {
    const lines = chunk.text.split("\n");
    let isIntact = true;

    // Check for split tables: if chunk has table rows (lines with |),
    // verify it has at least a header separator (|---|)
    const tableLines = lines.filter((l) => l.includes("|") && l.trim() !== "|");
    if (tableLines.length > 0) {
      const hasSeparator = tableLines.some((l) => /\|[\s-]+\|/.test(l));
      if (tableLines.length >= 2 && !hasSeparator) {
        isIntact = false; // Table rows without header separator = likely split
      }
    }

    if (isIntact) intactChunks++;
  }
  const structuralIntegrityScore =
    chunks.length > 0 ? intactChunks / chunks.length : 1;

  return {
    chunkSizeDistribution: {
      score: round(sizeScore),
      reasoning: `Coefficient of variation: ${cv.toFixed(2)}. ${sizeScore >= 0.7 ? "Good size consistency" : "High variance in chunk sizes"}`,
    },
    deduplication: {
      score: round(dedupScore),
      reasoning: `${duplicatePairs} near-duplicate pairs out of ${totalPairs} total. ${dedupScore >= 0.95 ? "Minimal duplication" : "Significant duplication detected"}`,
    },
    metadataQuality: {
      score: round(metadataScore),
      reasoning: `${metadataPasses}/${chunks.length} chunks have citation-grade metadata (page numbers + informative section header)`,
    },
    sectionCoverage: {
      score: round(sectionCoverageScore),
      reasoning: sectionCoverageReasoning,
    },
    sentenceCompleteness: {
      score: round(sentenceCompletenessScore),
      reasoning: `${completeChunks}/${chunks.length} chunks start and end on clean boundaries`,
    },
    structuralIntegrity: {
      score: round(structuralIntegrityScore),
      reasoning: `${intactChunks}/${chunks.length} chunks have intact tables and lists`,
    },
  };
}

/**
 * Simple text similarity using Jaccard coefficient on word sets.
 */
function textSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/));
  const wordsB = new Set(b.toLowerCase().split(/\s+/));
  const intersection = new Set([...wordsA].filter((w) => wordsB.has(w)));
  const union = new Set([...wordsA, ...wordsB]);
  return union.size > 0 ? intersection.size / union.size : 0;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// --- Per-metric LLM Judges ---

/**
 * Context Recall: For each claim in the expected answer, determine whether
 * it can be attributed to any of the retrieved chunks.
 * Score = attributable claims / total claims.
 */
export async function judgeContextRecall(
  qa: GoldenQA,
  retrievedChunks: SimilarityResult[],
): Promise<ContextRecallResult> {
  const claims = qa.claims ?? [];
  if (claims.length === 0) {
    return { claimAttributions: [], score: 1 };
  }

  const combinedRetrieved = retrievedChunks
    .map((c, i) => `[Chunk ${i + 1}]: ${c.text}`)
    .join("\n\n");

  const { output } = await generateText({
    model: PIPELINE_MODEL,
    output: Output.object({
      name: "ContextRecall",
      description: "Per-claim attribution against retrieved chunks",
      schema: contextRecallResultSchema,
    }),
    prompt: `You are evaluating the recall of a retrieval system. Given a list of factual claims that should be present in the retrieved context, determine whether each claim can be attributed to any of the retrieved chunks.

For each claim, respond with:
- attributed: true if the claim's information is present in any retrieved chunk (even if phrased differently)
- attributed: false if the claim's information is NOT present in any retrieved chunk
- chunkIndex: the 1-based index of the supporting chunk, or null if not found
- reasoning: brief explanation

**Claims to verify:**
${claims.map((c, i) => `${i + 1}. ${c}`).join("\n")}

**Retrieved chunks:**
${combinedRetrieved}`,
  });

  if (!output) {
    throw new Error(`Context Recall judge failed for: ${qa.question}`);
  }

  const attributedCount = output.claimAttributions.filter(
    (a) => a.attributed,
  ).length;
  const score = claims.length > 0 ? attributedCount / claims.length : 1;

  return {
    claimAttributions: output.claimAttributions,
    score: round(score),
  };
}

/**
 * Context Precision: For each retrieved chunk (in rank order), determine
 * whether it is useful for answering the question.
 * Score = weighted precision@k (relevant chunks ranked higher = better score).
 */
export async function judgeContextPrecision(
  qa: GoldenQA,
  retrievedChunks: SimilarityResult[],
): Promise<ContextPrecisionResult> {
  if (retrievedChunks.length === 0) {
    return { chunkVerdicts: [], score: 0 };
  }

  const combinedRetrieved = retrievedChunks
    .map((c, i) => `[Chunk ${i + 1}]: ${c.text}`)
    .join("\n\n");

  const { output } = await generateText({
    model: PIPELINE_MODEL,
    output: Output.object({
      name: "ContextPrecision",
      description: "Per-chunk usefulness verdicts in rank order",
      schema: contextPrecisionResultSchema,
    }),
    prompt: `You are evaluating the precision of a retrieval system. The chunks below are shown in their retrieval rank order (Chunk 1 = highest ranked).

For each chunk, determine whether it is useful for answering the given question. A chunk is "useful" if it contains information that helps answer the question — it doesn't need to be a complete answer.

**Question:** ${qa.question}

**Expected answer:** ${qa.answer}

**Retrieved chunks (in rank order):**
${combinedRetrieved}

For each chunk, provide:
- useful: true/false
- reasoning: brief explanation`,
  });

  if (!output) {
    throw new Error(`Context Precision judge failed for: ${qa.question}`);
  }

  // Weighted precision@k: Sum(precision@k * relevance_k) / total_relevant
  // where precision@k = relevant_items_in_top_k / k
  const verdicts = output.chunkVerdicts;
  let relevantSoFar = 0;
  let weightedSum = 0;
  const totalRelevant = verdicts.filter((v) => v.useful).length;

  for (let k = 0; k < verdicts.length; k++) {
    if (verdicts[k].useful) {
      relevantSoFar++;
      weightedSum += relevantSoFar / (k + 1);
    }
  }

  const score = totalRelevant > 0 ? weightedSum / totalRelevant : 0;

  return {
    chunkVerdicts: verdicts,
    score: round(score),
  };
}

/**
 * Coherence: Do the retrieved chunks form a readable, well-structured passage?
 * Evaluated independently — only needs the chunks, not the question.
 */
export async function judgeCoherence(
  retrievedChunks: SimilarityResult[],
): Promise<DimensionScore> {
  if (retrievedChunks.length === 0) {
    return { score: 0, reasoning: "No chunks retrieved" };
  }

  const combinedRetrieved = retrievedChunks
    .map((c, i) => `[Chunk ${i + 1}]: ${c.text}`)
    .join("\n\n");

  const { output } = await generateText({
    model: PIPELINE_MODEL,
    output: Output.object({
      name: "CoherenceScore",
      description: "Coherence score for retrieved chunks",
      schema: dimensionScoreSchema,
    }),
    prompt: `You are evaluating the coherence of text chunks retrieved from a document.

Score from 0.0 to 1.0:
- 1.0 = Chunks form a coherent, well-structured body of text. Complete sentences, logical flow, no mid-sentence breaks.
- 0.5 = Some fragmentation — occasional broken sentences or awkward boundaries, but mostly readable.
- 0.0 = Severely fragmented — mid-sentence breaks, tables split across chunks, unreadable passages.

**Retrieved chunks:**
${combinedRetrieved}

Score the coherence of these chunks as a readable body of text.`,
  });

  if (!output) {
    throw new Error("Coherence judge failed");
  }

  return { score: round(output.score), reasoning: output.reasoning };
}

/**
 * Faithfulness: Are the retrieved chunks relevant to and faithful to the
 * question's topic? Do they contain the right information?
 */
export async function judgeFaithfulness(
  qa: GoldenQA,
  retrievedChunks: SimilarityResult[],
): Promise<DimensionScore> {
  if (retrievedChunks.length === 0) {
    return { score: 0, reasoning: "No chunks retrieved" };
  }

  const combinedRetrieved = retrievedChunks
    .map((c, i) => `[Chunk ${i + 1}]: ${c.text}`)
    .join("\n\n");

  const { output } = await generateText({
    model: PIPELINE_MODEL,
    output: Output.object({
      name: "FaithfulnessScore",
      description: "Faithfulness score for retrieved chunks",
      schema: dimensionScoreSchema,
    }),
    prompt: `You are evaluating whether retrieved chunks are relevant to and faithful to a question's topic.

Score from 0.0 to 1.0:
- 1.0 = All chunks are on-topic and contain information directly relevant to the question. No irrelevant or off-topic content.
- 0.5 = Some chunks are relevant, but others are off-topic or tangential.
- 0.0 = Retrieved chunks are completely unrelated to the question.

**Question:** ${qa.question}

**Expected answer:** ${qa.answer}

**Source passage from manual:** ${qa.sourcePassage}

**Retrieved chunks:**
${combinedRetrieved}

Score how relevant and faithful the retrieved chunks are to the question.`,
  });

  if (!output) {
    throw new Error(`Faithfulness judge failed for: ${qa.question}`);
  }

  return { score: round(output.score), reasoning: output.reasoning };
}

// --- Convenience wrapper (calls all 3 judges) ---

/**
 * Uses three per-metric LLM judges to score retrieved chunks against a golden Q&A pair.
 *
 * Metrics: Faithfulness, Context Recall, Context Precision — the three
 * RAGAS retrieval metrics. Coherence is not evaluated at the retrieval
 * stage (it is a generation-quality metric — see docs/ingestion-pipeline.md).
 */
export async function judgeRetrieval(
  qa: GoldenQA,
  retrievedChunks: SimilarityResult[],
): Promise<JudgmentResult> {
  const retrievedTexts = retrievedChunks.map((c) => c.text);

  // Run all three judges in parallel
  const [faithfulnessResult, recallResult, precisionResult] = await Promise.all(
    [
      judgeFaithfulness(qa, retrievedChunks),
      judgeContextRecall(qa, retrievedChunks),
      judgeContextPrecision(qa, retrievedChunks),
    ],
  );

  const judgment: Judgment = {
    faithfulness: faithfulnessResult,
    contextRecall: {
      score: recallResult.score,
      reasoning: `${recallResult.claimAttributions.filter((a) => a.attributed).length}/${recallResult.claimAttributions.length} claims attributed`,
    },
    contextPrecision: {
      score: precisionResult.score,
      reasoning: `${precisionResult.chunkVerdicts.filter((v) => v.useful).length}/${precisionResult.chunkVerdicts.length} chunks useful, weighted precision@k = ${precisionResult.score}`,
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
    retrievedTexts,
    judgment,
    averageScore,
    contextRecallDetail: recallResult,
    contextPrecisionDetail: precisionResult,
  };
}

// --- Aggregation ---

export interface EvalReport {
  productId: string;
  timestamp: string;
  totalQuestions: number;
  passedQuestions: number;
  passRate: number;
  overallScore: number;
  dimensionAverages: {
    faithfulness: number;
    contextRecall: number;
    contextPrecision: number;
  };
  secondaryScores: SecondaryScores;
  thresholds: ScoreThresholds;
  passed: boolean;
  results: JudgmentResult[];
}

/**
 * Aggregates individual judgment results into an eval report with pass/fail.
 */
export function aggregateResults(
  results: JudgmentResult[],
  secondaryScores: SecondaryScores,
  productId: string,
  thresholds: ScoreThresholds = DEFAULT_THRESHOLDS,
): EvalReport {
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
    faithfulness: round(
      results.reduce((sum, r) => sum + r.judgment.faithfulness.score, 0) /
        (totalQuestions || 1),
    ),
    contextRecall: round(
      results.reduce((sum, r) => sum + r.judgment.contextRecall.score, 0) /
        (totalQuestions || 1),
    ),
    contextPrecision: round(
      results.reduce((sum, r) => sum + r.judgment.contextPrecision.score, 0) /
        (totalQuestions || 1),
    ),
  };

  const passed =
    overallScore >= thresholds.overall && passRate >= thresholds.passRate;

  return {
    productId,
    timestamp: new Date().toISOString(),
    totalQuestions,
    passedQuestions,
    passRate: round(passRate),
    overallScore,
    dimensionAverages,
    secondaryScores,
    thresholds,
    passed,
    results,
  };
}
