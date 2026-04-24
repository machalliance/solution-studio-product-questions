import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { generateText } from "ai";

const MARKDOWN_DIR = resolve(__dirname, "../../data/markdown");
export const EXTRACTION_MODEL = "google/gemini-3-pro-preview";

export interface ExtractMarkdownOptions {
  /** Regenerate Markdown even if a cached version exists */
  force?: boolean;
}

/**
 * Returns the cache path for a product's Markdown extraction.
 */
export function markdownCachePath(productId: string): string {
  return resolve(MARKDOWN_DIR, `${productId}.md`);
}

/**
 * Extracts a PDF to structured Markdown using Gemini 3 Pro via the Vercel AI Gateway.
 * Results are cached to disk at `data/markdown/{productId}.md`.
 *
 * If a cached file exists (and `force` is not set), returns the cached content
 * without making an API call.
 */
export async function extractToMarkdown(
  pdfPath: string,
  productId: string,
  options: ExtractMarkdownOptions = {},
): Promise<{ markdown: string; cached: boolean }> {
  const cachePath = markdownCachePath(productId);

  // Return cached version if available
  if (!options.force && existsSync(cachePath)) {
    const markdown = readFileSync(cachePath, "utf-8");
    return { markdown, cached: true };
  }

  // Read the PDF as a binary buffer
  const pdfBuffer = readFileSync(pdfPath);

  const { text } = await generateText({
    model: EXTRACTION_MODEL,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "file",
            data: pdfBuffer,
            mediaType: "application/pdf",
          },
          {
            type: "text",
            text: `Convert this PDF document to well-structured Markdown. Follow these rules:

1. **Headings**: Use Markdown headings (#, ##, ###) to preserve the document's hierarchy. Each major section should be an H2 (##), subsections H3 (###).
2. **Tables**: Convert all tables to Markdown table syntax with proper alignment.
3. **Lists**: Preserve bulleted and numbered lists using Markdown syntax.
4. **Formatting**: Maintain bold, italic, and other emphasis where present in the original.
5. **Layout**: Linearize multi-column layouts in left-to-right, top-to-bottom reading order.
6. **Language**: Extract ONLY English content. Skip sections in other languages (German, French, Italian, etc.). If a page contains mixed languages, extract only the English portions.
7. **Artifacts**: Remove page numbers, headers/footers, and other repeated navigation elements.
8. **Completeness**: Include ALL English content — do not summarize or skip sections.

Output clean Markdown only. Do not wrap in a code fence. Do not add commentary.`,
          },
        ],
      },
    ],
  });

  // Cache the result to disk
  const dir = dirname(cachePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(cachePath, text, "utf-8");

  return { markdown: text, cached: false };
}
