import { Output, generateText } from "ai";
import { z } from "zod";
import type { ProductData } from "../product/types";
import type { SimilarityResult } from "../db/vectors";
import { createSeedQuestion } from "./cache";
import type { SeedQuestion } from "./types";
import { retrieveChunks } from "../retrieval";

const GENERATION_MODEL = "anthropic/claude-sonnet-4-5";

const seedQuestionSchema = z.object({
  question: z
    .string()
    .describe("A natural question a shopper would ask about the product"),
});

const answerabilitySchema = z.object({
  answerable: z
    .boolean()
    .describe("Whether the question can be reliably answered from the chunks"),
  groundingQuote: z
    .string()
    .describe(
      "Exact sentence (or two) copied verbatim from the chunks that answers the behavior/fact the question asks about. Empty string when not answerable.",
    ),
  reason: z
    .string()
    .describe("Brief explanation of why the question is or is not answerable"),
});

/**
 * Generates candidate seed questions grounded in the full product manual.
 *
 * The generator reads the entire Markdown document via a cached `<document>`
 * prefix so every candidate is anchored in content that actually exists.
 * The previous implementation fed only retrieved chunks, which shared a blind
 * spot with the validator and caused it to invent questions about topics the
 * retrieved slice didn't mention.
 */
export async function generateCandidates(
  product: ProductData,
  markdown: string,
  count: number,
): Promise<string[]> {
  const productContext = [
    `Product: ${product.name}`,
    `Brand: ${product.brand}`,
    `Price: $${product.price} ${product.currency}`,
    `Description: ${product.description}`,
    `Features: ${product.features.join(", ")}`,
  ].join("\n");

  const instructions = `You are generating seed questions for a product Q&A widget on an e-commerce product page.

Generate exactly ${count} questions that a real shopper would want to ask before purchasing this product.

Requirements:
- Questions should be concise (under 80 characters)
- Questions should be diverse — cover features, setup, maintenance, comparisons, and use cases
- Questions should be engaging and encourage clicks
- Questions must be directly answerable from the product manual above — do not invent topics that aren't in the document
- Avoid overly generic questions like "Tell me about this product"
- Avoid questions about pricing, warranty, or return policies (these are handled by customer support)

Product context:
${productContext}`;

  const { output } = await generateText({
    model: GENERATION_MODEL,
    output: Output.array({
      name: "SeedQuestions",
      description:
        "Seed questions for a product Q&A widget that shoppers will click",
      element: seedQuestionSchema,
    }),
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `<document>\n${markdown}\n</document>`,
            // Cache the full manual — the generator reuses this prefix on every
            // regeneration run and any future per-section candidate calls.
            providerOptions: {
              anthropic: {
                cacheControl: { type: "ephemeral" },
              },
            },
          },
          {
            type: "text",
            text: instructions,
          },
        ],
      },
    ],
  });

  if (!output) {
    throw new Error("LLM failed to generate seed questions");
  }

  return output.map((item) => item.question);
}

/**
 * Validates whether a single candidate question is answerable from the chunks
 * that runtime retrieval would surface for *that specific question*. This
 * mirrors what the chat endpoint does at query time — if those chunks don't
 * ground an answer here, they won't at runtime either.
 */
export interface AnswerabilityVerdict {
  answerable: boolean;
  reason: string;
}

export async function validateAnswerability(
  candidate: string,
  retrievedChunks: SimilarityResult[],
): Promise<AnswerabilityVerdict> {
  const chunkContext = retrievedChunks
    .map((c, i) => formatChunkForPrompt(c, i))
    .join("\n\n");

  const { output } = await generateText({
    model: GENERATION_MODEL,
    output: Output.object({
      name: "AnswerabilityVerdict",
      description:
        "Verdict on whether the candidate question can be answered from the retrieved chunks",
      schema: answerabilitySchema,
    }),
    prompt: `You are judging whether a single shopper question can be reliably answered from the chunks retrieved for that question at runtime.

A question is answerable ONLY when the chunks contain a sentence (or two) that directly states the behavior or fact the question asks about. Copy that sentence verbatim into \`groundingQuote\`.

A question is NOT answerable when:
- The chunks mention the topic only in a component list, spec table, or parts diagram (e.g. "Carpet Sensor" appearing in a list of sensors is NOT grounding for "Does it avoid carpets?" — the behavior is never described).
- Answering would require inferring behavior from the mere presence of a feature name.
- The chunks are topically related but don't answer the specific thing being asked.
- The answer would require speculation, external knowledge, or competitor/future-product comparisons.

Be strict: if you cannot copy a sentence that literally answers the question, mark it not answerable and leave \`groundingQuote\` empty. A topical match is not grounding.

Candidate question:
${candidate}

Retrieved chunks (what the runtime answerer will see for this exact question):
${chunkContext}`,
  });

  if (!output) {
    throw new Error("LLM failed to validate answerability");
  }

  // Belt-and-suspenders: if the model says answerable but failed to quote a
  // grounding sentence, treat it as unanswerable. The quote is the whole point
  // of the stricter rule.
  if (output.answerable && output.groundingQuote.trim().length === 0) {
    return {
      answerable: false,
      reason: `validator said answerable but returned no grounding quote: ${output.reason}`,
    };
  }

  return {
    answerable: output.answerable,
    reason: output.reason,
  };
}

/**
 * Full generation pipeline: generate candidates against the full document,
 * then for each candidate fetch the chunks runtime retrieval would surface
 * and ask the validator whether those chunks actually ground an answer.
 *
 * Per-candidate retrieval (vs. a shared representative slice) matches what
 * the chat endpoint does at query time. If the validator can't find grounding
 * in the runtime chunks, the runtime answerer won't either.
 */
export async function generateSeedQuestions(
  product: ProductData,
  markdown: string,
  candidateCount: number,
): Promise<SeedQuestion[]> {
  const candidates = await generateCandidates(
    product,
    markdown,
    candidateCount,
  );

  const verdicts = await Promise.all(
    candidates.map(async (question) => {
      const chunks = await retrieveChunks(question, {
        productId: product.id,
      });
      if (chunks.length === 0) {
        return {
          answerable: false,
          reason: "runtime retrieval returned no chunks for this question",
        };
      }
      return validateAnswerability(question, chunks);
    }),
  );

  // Surface why candidates were rejected — without this, tuning the
  // generator or the validator is reading tea leaves.
  for (let i = 0; i < candidates.length; i++) {
    const v = verdicts[i];
    if (!v.answerable) {
      console.log(
        `  [seed-questions] rejected ${i}: "${candidates[i]}" — ${v.reason}`,
      );
    }
  }

  const validQuestions = candidates
    .filter((_, i) => verdicts[i].answerable)
    .map((text) => createSeedQuestion(text, product.id));

  const answerable = validQuestions.length;
  const total = candidates.length;
  const ratio = total > 0 ? Math.round((answerable / total) * 100) : 0;
  console.log(
    `[seed-questions] ${total} candidates → ${answerable} answerable (${ratio}%)`,
  );

  return validQuestions;
}

/**
 * Formats a retrieved chunk for LLM prompts used at generation/validation time.
 * Prepends the Contextual Retrieval header (when present) so the model sees
 * the same situating sentence the embedding was tuned against — otherwise the
 * validator over-rejects candidates that are perfectly answerable once the
 * chunk is read in context.
 */
function formatChunkForPrompt(chunk: SimilarityResult, i: number): string {
  const header = chunk.context?.trim();
  if (header && header.length > 0) {
    return `[Chunk ${i + 1}] ${header}\n${chunk.text}`;
  }
  return `[Chunk ${i + 1}] ${chunk.text}`;
}
