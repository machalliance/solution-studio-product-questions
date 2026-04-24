import { generateText } from "ai";
import type { RawChunk } from "./chunk";
import { FALLBACK_PROMPTS, PROMPT_NAMES } from "@/server/prompts/hub";

/**
 * Model used to generate per-chunk context blurbs. Same Claude Sonnet 4.5
 * already used for judges and seed questions — no new provider wiring needed.
 */
export const CONTEXT_MODEL = "anthropic/claude-sonnet-4-5";

/**
 * Max parallel requests to the context model. Mirrors the embedding pipeline's
 * bound (`embedMany` uses `maxParallelCalls: 5`) — same rate-limit budget.
 */
const MAX_PARALLEL = 5;

/**
 * Retry budget for each context request. `generateText` retries transient
 * failures internally, but we wrap a small extra loop to survive provider
 * flakes without failing a multi-minute ingestion.
 */
const MAX_ATTEMPTS = 3;

export interface ContextualizeOptions {
  /** Override the context model (useful for tests). */
  model?: string;
  /** Max parallel requests. Defaults to 5. */
  maxParallel?: number;
  /** Progress callback, called after each chunk resolves. */
  onProgress?: (completed: number, total: number) => void;
}

/**
 * Generates a 1–2 sentence context blurb for each chunk, using Anthropic's
 * Contextual Retrieval prompt pattern. The full document is included in each
 * request so the model can situate each chunk globally; prompt caching on the
 * document prefix makes this economically viable (paid once, reused N times).
 *
 * Returns contexts in the same order as `chunks`. A failed request produces
 * an empty string for that chunk so ingestion can proceed without the header
 * rather than failing the whole pipeline.
 */
export async function generateChunkContexts(
  markdown: string,
  chunks: RawChunk[],
  options: ContextualizeOptions = {},
): Promise<string[]> {
  if (chunks.length === 0) return [];

  const model = options.model ?? CONTEXT_MODEL;
  const maxParallel = options.maxParallel ?? MAX_PARALLEL;
  const { onProgress } = options;

  const systemPrompt =
    FALLBACK_PROMPTS[PROMPT_NAMES.CHUNK_CONTEXTUALIZER_SYSTEM].template;

  const results: string[] = new Array(chunks.length).fill("");
  let nextIndex = 0;
  let completed = 0;

  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= chunks.length) return;
      try {
        results[i] = await generateSingleContext({
          model,
          systemPrompt,
          markdown,
          chunkText: chunks[i].text,
        });
      } catch {
        results[i] = "";
      }
      completed++;
      onProgress?.(completed, chunks.length);
    }
  }

  const workers = Array.from(
    { length: Math.min(maxParallel, chunks.length) },
    () => worker(),
  );
  await Promise.all(workers);

  return results;
}

interface SingleContextParams {
  model: string;
  systemPrompt: string;
  markdown: string;
  chunkText: string;
}

async function generateSingleContext(
  params: SingleContextParams,
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const { text } = await generateText({
        model: params.model,
        system: params.systemPrompt,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `<document>\n${params.markdown}\n</document>`,
                // Cache the document prefix — reused verbatim across all N chunk requests
                // so we pay the extraction cost once per ingestion run.
                providerOptions: {
                  anthropic: {
                    cacheControl: { type: "ephemeral" },
                  },
                },
              },
              {
                type: "text",
                text: `<chunk>\n${params.chunkText}\n</chunk>\n\nPlease give a short succinct context to situate this chunk within the overall document for the purposes of improving search retrieval of the chunk. Answer only with the succinct context and nothing else.`,
              },
            ],
          },
        ],
      });
      return text.trim();
    } catch (error) {
      lastError = error;
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
      }
    }
  }
  throw lastError;
}
