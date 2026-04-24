import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { Output, generateText } from "ai";
import { z } from "zod";

/**
 * Schema for a single golden Q&A pair.
 */
export const goldenQASchema = z.object({
  question: z.string().describe("A natural question a shopper would ask"),
  answer: z
    .string()
    .describe("The expected answer derived from the product manual"),
  sourcePassage: z
    .string()
    .describe(
      "The exact passage from the manual that supports this answer (verbatim or near-verbatim)",
    ),
  topic: z
    .string()
    .describe(
      "The topic category: safety, setup, usage, maintenance, troubleshooting, specifications, package-contents, or general",
    ),
  claims: z
    .array(z.string())
    .describe(
      "Atomic factual claims the answer contains — each independently verifiable against the source document",
    ),
  relevantSections: z
    .array(z.string())
    .describe(
      "Markdown heading texts (e.g. 'Safety Information', 'Package Contents') from the source that contain relevant information for this question",
    ),
});

export type GoldenQA = z.infer<typeof goldenQASchema>;

export interface EvalSet {
  productId: string;
  generatedAt: string;
  model: string;
  items: GoldenQA[];
}

const EVAL_SET_DIR = resolve(__dirname, "../../data/eval-sets");
const PIPELINE_MODEL = "anthropic/claude-sonnet-4-5";

/**
 * Returns the file path for a cached eval set for a given product.
 */
export function evalSetPath(productId: string): string {
  return resolve(EVAL_SET_DIR, `${productId}.json`);
}

/**
 * Loads a cached eval set from disk. Returns null if no cache exists.
 */
export function loadEvalSet(productId: string): EvalSet | null {
  const path = evalSetPath(productId);
  if (!existsSync(path)) return null;

  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as EvalSet;
  } catch {
    return null;
  }
}

/**
 * Saves an eval set to disk.
 */
export function saveEvalSet(evalSet: EvalSet): void {
  const path = evalSetPath(evalSet.productId);
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, JSON.stringify(evalSet, null, 2), "utf-8");
}

/**
 * Generates golden Q&A pairs from product Markdown content using an LLM.
 * Returns 25 pairs covering the product's key topics. 25 is a demo-appropriate
 * size: above the ~20 floor where per-question swings dominate aggregate
 * scores, below the 50–100 range that production teams use (at which point
 * SME curation and stratification matter more than raw count). See
 * docs/production-scaling/ingestion.md for the scaling story.
 *
 * Accepts Markdown text (from Gemini extraction) for better structured input.
 */
export async function generateEvalSet(
  markdownText: string,
  productId: string,
): Promise<EvalSet> {
  const { output } = await generateText({
    model: PIPELINE_MODEL,
    output: Output.array({
      name: "GoldenQAPairs",
      description:
        "Golden Q&A evaluation pairs derived from a product manual for testing a RAG system",
      element: goldenQASchema,
    }),
    prompt: `You are an evaluation set generator for a product question-answering system.

Given the following product manual text, generate 25 golden question-answer pairs that a real shopper would ask about this product.

Requirements:
- Generate exactly 25 Q&A pairs
- Cover diverse topics: safety, setup, usage, maintenance, troubleshooting, specifications, package-contents
- Questions should be natural and varied — some simple ("What's included in the box?"), some detailed ("How do I perform routine maintenance?"), some comparative ("What safety precautions should I follow?")
- Each answer must be directly derivable from the manual text
- Each sourcePassage must be the verbatim or near-verbatim text from the manual that supports the answer
- Ensure good coverage across different sections of the manual
- Include at least 2 questions per major topic area

For each Q&A pair, also provide:
- **claims**: Break the answer into atomic factual claims — individual facts that can each be independently verified against the source document. Each claim should be a single, self-contained statement (e.g., "The robot supports only 2.4 GHz Wi-Fi" rather than a compound statement). Aim for 2-8 claims per answer depending on answer complexity.
- **relevantSections**: List the Markdown heading texts from the manual that contain information relevant to this question (e.g., "Safety Information", "Package Contents", "Wi-Fi Setup"). Use the exact heading text as it appears in the document.

Product manual text:
${markdownText}`,
  });

  if (!output) {
    throw new Error("LLM failed to generate golden Q&A pairs");
  }

  const evalSet: EvalSet = {
    productId,
    generatedAt: new Date().toISOString(),
    model: PIPELINE_MODEL,
    items: output,
  };

  return evalSet;
}

/**
 * Gets or generates an eval set for a product. Uses cached version if available.
 */
export async function getOrGenerateEvalSet(
  markdownText: string,
  productId: string,
): Promise<EvalSet> {
  const cached = loadEvalSet(productId);
  if (cached) return cached;

  const evalSet = await generateEvalSet(markdownText, productId);
  saveEvalSet(evalSet);
  return evalSet;
}
