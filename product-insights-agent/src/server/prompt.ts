import type { SimilarityResult } from "./db/vectors";
import type { ProductData } from "./product/types";
import { pullPrompt, applyTemplate, PROMPT_NAMES } from "./prompts/hub";

/**
 * Builds the system prompt with product context.
 *
 * Pulls the `product-insights-agent-assistant-system` prompt from LangSmith Hub at runtime,
 * falling back to the hardcoded template in `lib/prompts/hub.ts` if the hub
 * is unreachable or tracing is disabled.
 */
export async function buildSystemPrompt(product: ProductData): Promise<string> {
  const prompt = await pullPrompt(PROMPT_NAMES.ASSISTANT_SYSTEM);
  return applyTemplate(prompt, {
    productName: product.name,
    productBrand: product.brand,
  });
}

/**
 * Formats retrieved chunks into a context block for the prompt.
 */
export function formatRetrievedContext(chunks: SimilarityResult[]): string {
  if (chunks.length === 0) {
    return "<context>\nNo relevant documentation found.\n</context>";
  }

  const formattedChunks = chunks
    .map((chunk, i) => {
      const header = chunk.metadata.sectionHeader;
      const pages = chunk.metadata.pageNumbers.join(", ");
      return `[Source ${i + 1}: ${header} (p. ${pages}), relevance: ${chunk.score.toFixed(2)}]\n${chunk.text}`;
    })
    .join("\n\n");

  return `<context>\n${formattedChunks}\n</context>`;
}

/**
 * Formats product data into a concise context summary.
 */
export function formatProductContext(product: ProductData): string {
  const specs = Object.entries(product.specifications)
    .map(([key, value]) => `- ${key}: ${value}`)
    .join("\n");

  const features = product.features.map((f) => `- ${f}`).join("\n");

  return `<product-info>
Name: ${product.name}
Brand: ${product.brand}
Model: ${product.model}
Price: $${product.price} ${product.currency}
Category: ${product.category}

Key Features:
${features}

Specifications:
${specs}
</product-info>`;
}

/**
 * Wraps the user's input in untrusted-input tags per a2as.org in-context defense.
 */
export function wrapUserInput(input: string): string {
  return `<untrusted-input>\n${input}\n</untrusted-input>`;
}

/**
 * Builds the full user message combining product context, retrieved chunks, and the user question.
 */
export function buildUserMessage(
  product: ProductData,
  chunks: SimilarityResult[],
  userQuestion: string,
): string {
  const productContext = formatProductContext(product);
  const retrievedContext = formatRetrievedContext(chunks);
  const wrappedInput = wrapUserInput(userQuestion);

  return `${productContext}\n\n${retrievedContext}\n\n${wrappedInput}`;
}
