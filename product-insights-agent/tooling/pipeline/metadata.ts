import type { RawChunk } from "./chunk";
import { countTokens } from "./tokens";

export interface ChunkMetadata {
  sectionHeader: string;
  pageNumbers: number[];
  chunkIndex: number;
  charCount: number;
  tokenCount: number;
}

export interface EnrichedChunk {
  /** Original chunk text — this is what the runtime LLM answer path consumes. */
  text: string;
  /**
   * 1–2 sentence LLM-generated context header situating this chunk within the
   * document. Used for retrieval (prepended to `text` before embedding) but
   * never shown to the runtime answerer. Empty string if contextual retrieval
   * is disabled or context generation failed for this chunk.
   */
  context: string;
  /** What actually gets embedded: `${context}\n\n${text}` when context is present. */
  embeddingInput: string;
  metadata: ChunkMetadata;
}

/**
 * Enriches raw chunks with metadata: size counts (chars + tokens) and
 * structured metadata object. Initializes the `context` and `embeddingInput`
 * fields to empty/text so downstream code can populate them after contextualization.
 */
export function enrichChunks(chunks: RawChunk[]): EnrichedChunk[] {
  return chunks.map((chunk) => ({
    text: chunk.text,
    context: "",
    embeddingInput: chunk.text,
    metadata: {
      sectionHeader: chunk.sectionHeader,
      pageNumbers: chunk.pageNumbers,
      chunkIndex: chunk.index,
      charCount: chunk.text.length,
      tokenCount: countTokens(chunk.text),
    },
  }));
}

/**
 * Applies contextual headers to already-enriched chunks in place (returns a new
 * array). Each context string in `contexts` is positionally matched to the
 * corresponding chunk. Empty strings are treated as "no context available"
 * and leave the chunk unchanged.
 */
export function applyChunkContexts(
  chunks: EnrichedChunk[],
  contexts: string[],
): EnrichedChunk[] {
  if (contexts.length !== chunks.length) {
    throw new Error(
      `applyChunkContexts: contexts length (${contexts.length}) does not match chunks length (${chunks.length})`,
    );
  }
  return chunks.map((chunk, i) => {
    const context = contexts[i]?.trim() ?? "";
    if (context.length === 0) return chunk;
    return {
      ...chunk,
      context,
      embeddingInput: `${context}\n\n${chunk.text}`,
    };
  });
}
