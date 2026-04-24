import { countTokens } from "./tokens";

export interface ChunkConfig {
  /** Target chunk size in tokens (cl100k_base) */
  chunkSize: number;
  /** Overlap between adjacent chunks in tokens */
  overlap: number;
  /** Minimum chunk size in tokens — chunks below this are merged with neighbors */
  minChunkSize: number;
  /** Split on these patterns to find natural boundaries within sections */
  splitPatterns: RegExp[];
}

export const DEFAULT_CHUNK_CONFIG: ChunkConfig = {
  chunkSize: 256,
  overlap: 100,
  minChunkSize: 50,
  splitPatterns: [
    /\n\n/, // Double newline (paragraph break)
    /\n(?=[A-Z\d])/, // Newline followed by uppercase letter or number
    /\.\s/, // Sentence boundary
  ],
};

export interface RawChunk {
  text: string;
  pageNumbers: number[];
  sectionHeader: string;
  index: number;
}

interface MarkdownSection {
  heading: string;
  content: string;
}

/**
 * Splits Markdown text on headings (#, ##, ###) into sections.
 * Each section includes the heading text as metadata.
 */
function splitOnHeadings(markdown: string): MarkdownSection[] {
  // Match lines that start with 1-3 # characters followed by a space
  const headingPattern = /^(#{1,3})\s+(.+)$/gm;
  const sections: MarkdownSection[] = [];
  const matches = [...markdown.matchAll(headingPattern)];

  if (matches.length === 0) {
    // No headings found — treat entire text as one section
    return [{ heading: "General", content: markdown.trim() }];
  }

  // Content before the first heading
  const preHeadingContent = markdown.substring(0, matches[0].index).trim();
  if (preHeadingContent.length > 0) {
    sections.push({ heading: "General", content: preHeadingContent });
  }

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const heading = match[2].trim();
    const startAfterHeading = (match.index ?? 0) + match[0].length;
    const endPos =
      i + 1 < matches.length
        ? (matches[i + 1].index ?? markdown.length)
        : markdown.length;
    const content = markdown.substring(startAfterHeading, endPos).trim();

    sections.push({ heading, content });
  }

  return sections;
}

/**
 * Estimates a character position that corresponds to roughly `targetTokens`
 * tokens from `startCharPos`. Uses a character-per-token ratio derived from
 * the full text to pick an initial target, then refines.
 */
function estimateCharPosForTokens(
  text: string,
  startCharPos: number,
  targetTokens: number,
): number {
  const remaining = text.substring(startCharPos);
  if (remaining.length === 0) return startCharPos;

  // Rough initial estimate: cl100k_base averages ~4 chars/token for English prose.
  // Refine by measuring and scaling.
  let charEstimate = Math.min(remaining.length, targetTokens * 4);
  const tokens = countTokens(remaining.substring(0, charEstimate));

  // Scale up or down based on observed ratio.
  if (tokens > 0) {
    const ratio = charEstimate / tokens;
    charEstimate = Math.min(
      remaining.length,
      Math.max(1, Math.round(targetTokens * ratio)),
    );
  }

  return startCharPos + charEstimate;
}

/**
 * Splits text at the best available boundary near the target position.
 * Tries split patterns in order of preference (paragraph > sentence > word).
 */
function findSplitPoint(
  text: string,
  targetPos: number,
  config: ChunkConfig,
): number {
  // Window scales with chunk size (in tokens) at the same ~4:1 char ratio
  const window = Math.floor(config.chunkSize * 0.3 * 4);
  const searchStart = Math.max(0, targetPos - window);
  const searchEnd = Math.min(text.length, targetPos + window);
  const searchRegion = text.substring(searchStart, searchEnd);

  for (const pattern of config.splitPatterns) {
    const matches = [...searchRegion.matchAll(new RegExp(pattern, "g"))];
    if (matches.length > 0) {
      let bestMatch = matches[0];
      let bestDist = Math.abs(searchStart + (bestMatch.index ?? 0) - targetPos);
      for (const m of matches) {
        const dist = Math.abs(searchStart + (m.index ?? 0) - targetPos);
        if (dist < bestDist) {
          bestMatch = m;
          bestDist = dist;
        }
      }
      return searchStart + (bestMatch.index ?? 0) + bestMatch[0].length;
    }
  }

  return targetPos;
}

/**
 * Chunks Markdown text using heading-based splitting followed by
 * size-constrained sub-splitting within each section.
 *
 * Phase 1: Split on Markdown headings (#, ##, ###) — each heading becomes
 * a section boundary with heading metadata attached.
 *
 * Phase 2: Within each section, if text exceeds the target chunk size
 * (measured in tokens), apply recursive splitting on paragraph/sentence
 * boundaries.
 *
 * Sections whose body is below `minChunkSize` tokens are NOT dropped —
 * they're carried forward into `mergeSmallChunks` where they're combined
 * with neighboring chunks that share a heading, or ultimately emitted
 * as-is so small-but-meaningful sections (e.g., "Package Contents:
 * Robot, Base Station") don't vanish from retrieval.
 */
export function chunkMarkdown(
  markdown: string,
  config: ChunkConfig = DEFAULT_CHUNK_CONFIG,
): RawChunk[] {
  const sections = splitOnHeadings(markdown);
  const chunks: RawChunk[] = [];
  let globalIndex = 0;

  for (const section of sections) {
    const text = section.content;
    if (text.length === 0) continue;

    const sectionTokens = countTokens(text);

    // Short section: emit as a single chunk (may later merge with neighbors).
    if (sectionTokens <= config.chunkSize * 1.2) {
      chunks.push({
        text: text.trim(),
        pageNumbers: [],
        sectionHeader: section.heading,
        index: globalIndex++,
      });
      continue;
    }

    // Long section: walk through it, measuring progress in tokens.
    let pos = 0;
    while (pos < text.length) {
      const remainingText = text.substring(pos);
      const remainingTokens = countTokens(remainingText);

      if (remainingTokens <= config.chunkSize * 1.2) {
        // Remaining text fits in one chunk
        const chunkText = remainingText.trim();
        if (chunkText.length > 0) {
          chunks.push({
            text: chunkText,
            pageNumbers: [],
            sectionHeader: section.heading,
            index: globalIndex++,
          });
        }
        break;
      }

      const estimatedEnd = estimateCharPosForTokens(
        text,
        pos,
        config.chunkSize,
      );
      const splitAt = findSplitPoint(text, estimatedEnd, config);
      const chunkText = text.substring(pos, splitAt).trim();

      if (chunkText.length > 0) {
        chunks.push({
          text: chunkText,
          pageNumbers: [],
          sectionHeader: section.heading,
          index: globalIndex++,
        });
      }

      // Move pos forward by (chunk - overlap) tokens, approximated in chars.
      const overlapChars = Math.floor(config.overlap * 4);
      const nextPos = splitAt - overlapChars;
      pos = nextPos > pos ? nextPos : splitAt;
    }
  }

  return mergeSmallChunks(chunks, config);
}

/**
 * Merges chunks that are too small (in tokens) with their neighbors.
 * Prefers merging with same-heading neighbors; falls back to the next
 * chunk of any heading so small sections are never silently dropped.
 */
function mergeSmallChunks(chunks: RawChunk[], config: ChunkConfig): RawChunk[] {
  if (chunks.length === 0) return [];

  const merged: RawChunk[] = [];
  let current = chunks[0];

  for (let i = 1; i < chunks.length; i++) {
    const next = chunks[i];
    const currentTokens = countTokens(current.text);

    if (currentTokens < config.minChunkSize) {
      // Merge into the next chunk regardless of heading. Preserve the
      // current chunk's heading as a prefix so readers (and embeddings)
      // retain the section context.
      const combinedText =
        current.sectionHeader === next.sectionHeader
          ? current.text + "\n\n" + next.text
          : `${current.text}\n\n${next.text}`;
      current = {
        text: combinedText,
        pageNumbers: [
          ...new Set([...current.pageNumbers, ...next.pageNumbers]),
        ],
        sectionHeader:
          current.sectionHeader === next.sectionHeader
            ? current.sectionHeader
            : `${current.sectionHeader} / ${next.sectionHeader}`,
        index: current.index,
      };
    } else {
      merged.push(current);
      current = next;
    }
  }

  // Tail chunk: if still below minimum and we have a predecessor, fold it back.
  if (merged.length > 0 && countTokens(current.text) < config.minChunkSize) {
    const prev = merged[merged.length - 1];
    merged[merged.length - 1] = {
      text: prev.text + "\n\n" + current.text,
      pageNumbers: [...new Set([...prev.pageNumbers, ...current.pageNumbers])],
      sectionHeader:
        prev.sectionHeader === current.sectionHeader
          ? prev.sectionHeader
          : `${prev.sectionHeader} / ${current.sectionHeader}`,
      index: prev.index,
    };
  } else {
    merged.push(current);
  }

  return merged.map((c, i) => ({ ...c, index: i }));
}
