import { getEncoding, type Tiktoken } from "js-tiktoken";

/**
 * Tokenizer used for chunk sizing. We use `cl100k_base` because it's the
 * encoding for OpenAI `text-embedding-3-small` (our embedding model) and
 * for `gpt-4o` / `gpt-5-mini` (our chat model). One counter serves the
 * whole pipeline for chunk-size targeting and embedding budget checks.
 *
 * Claude and Gemini use different encodings, but we don't count their
 * tokens here — we only need a stable proxy for how big chunks are,
 * and `cl100k_base` is a close-enough proxy across modern tokenizers.
 */
const ENCODING = "cl100k_base";

let encoder: Tiktoken | undefined;

function getEncoder(): Tiktoken {
  if (!encoder) {
    encoder = getEncoding(ENCODING);
  }
  return encoder;
}

/**
 * Counts the number of `cl100k_base` tokens in a string.
 * Amortized: the encoder is loaded once and cached at module level.
 */
export function countTokens(text: string): number {
  if (text.length === 0) return 0;
  return getEncoder().encode(text).length;
}

/**
 * Truncates text to at most `maxTokens` tokens. Safe for inputs that are
 * already shorter than the limit (returns the original text).
 */
export function truncateToTokens(text: string, maxTokens: number): string {
  const tokens = getEncoder().encode(text);
  if (tokens.length <= maxTokens) return text;
  return getEncoder().decode(tokens.slice(0, maxTokens));
}
