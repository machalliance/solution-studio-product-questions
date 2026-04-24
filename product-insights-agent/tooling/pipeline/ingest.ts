import { resolve, basename } from "path";
import { statSync } from "fs";
import { extractToMarkdown, EXTRACTION_MODEL } from "./extract-markdown";
import { chunkMarkdown, DEFAULT_CHUNK_CONFIG, type ChunkConfig } from "./chunk";
import { enrichChunks, applyChunkContexts } from "./metadata";
import { generateChunkContexts, CONTEXT_MODEL } from "./contextualize";
import { buildProductCardChunks } from "./product-card-chunks";
import { getDb } from "@/server/db/client";
import {
  insertChunks,
  createVectorIndex,
  similaritySearch,
  EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
} from "@/server/db/vectors";
import { regenerateSeedQuestions } from "../scripts/regenerate-seed-questions";
import { FileProductDataAdapter } from "@/server/product/file-adapter";
import type { ProductDataAdapter } from "@/server/product/types";

const DEFAULT_PDF_PATH = resolve(
  __dirname,
  "../../data/example-product-pdf.pdf",
);
const DEFAULT_PRODUCT_ID = "dreame-x40-ultra";

export interface IngestOptions {
  pdfPath?: string;
  productId?: string;
  chunkConfig?: Partial<ChunkConfig>;
  verbose?: boolean;
  /** Force re-extraction of Markdown even if cache exists */
  forceExtract?: boolean;
  /**
   * Adapter used to fetch the structured product shape that gets synthesized
   * into product-card chunks. Defaults to the file-backed adapter; swap for
   * a commercetools/Shopify adapter without touching the pipeline.
   */
  productAdapter?: ProductDataAdapter;
}

export interface IngestResult {
  chunksCreated: number;
  productId: string;
  markdownCached: boolean;
  seedQuestionsCount: number;
}

function log(verbose: boolean, ...args: unknown[]) {
  if (verbose) console.log(...args);
}

/**
 * Runs the full ingestion pipeline:
 * 1. Extract PDF to Markdown via Gemini (or use cache)
 * 2. Chunk the Markdown (heading-based + recursive)
 * 3. Enrich chunks with metadata
 * 3b. Generate contextual headers per chunk (Anthropic Contextual Retrieval)
 * 3c. Synthesize product-card chunks from the structured product adapter
 * 4. Generate embeddings and store in MongoDB
 * 5. Create vector search index
 * 6. Regenerate seed questions against the fresh embeddings
 */
export async function ingest(
  options: IngestOptions = {},
): Promise<IngestResult> {
  const {
    pdfPath = DEFAULT_PDF_PATH,
    productId = DEFAULT_PRODUCT_ID,
    chunkConfig,
    verbose = false,
    forceExtract = false,
    productAdapter = new FileProductDataAdapter(),
  } = options;

  const config = chunkConfig
    ? { ...DEFAULT_CHUNK_CONFIG, ...chunkConfig }
    : DEFAULT_CHUNK_CONFIG;

  // Step 1: Extract PDF to Markdown via Gemini
  log(verbose, "Extracting PDF to Markdown...");
  const { markdown, cached } = await extractToMarkdown(pdfPath, productId, {
    force: forceExtract,
  });
  log(
    verbose,
    `  Markdown extraction: ${cached ? "using cache" : "fresh extraction via Gemini"}`,
  );
  log(verbose, `  Markdown length: ${markdown.length} characters`);

  // Step 2: Chunk the Markdown
  log(verbose, "Chunking Markdown...");
  const rawChunks = chunkMarkdown(markdown, config);
  log(verbose, `  Created ${rawChunks.length} chunks`);

  // Step 3: Enrich with metadata
  log(verbose, "Enriching chunks with metadata...");
  const enrichedChunks = enrichChunks(rawChunks);

  // Step 3b: Contextual Retrieval — generate a 1–2 sentence context header
  // per chunk. Prepended to the chunk before embedding; the raw text is
  // still what the runtime LLM answerer sees.
  log(verbose, "Generating contextual headers (Contextual Retrieval)...");
  const contexts = await generateChunkContexts(markdown, rawChunks, {
    onProgress: verbose
      ? (done, total) => {
          if (done === total || done % 5 === 0) {
            console.log(`    Contexts: ${done}/${total}`);
          }
        }
      : undefined,
  });
  const contextualChunks = applyChunkContexts(enrichedChunks, contexts);
  const withContext = contextualChunks.filter(
    (c) => c.context.length > 0,
  ).length;
  log(
    verbose,
    `  Context coverage: ${withContext}/${contextualChunks.length} chunks`,
  );

  // Step 3c: Synthesize product-card chunks from structured product data.
  // Skip contextualization — these chunks are already self-contained and short,
  // and their section headers carry enough signal on their own.
  log(verbose, "Building product-card chunks from product adapter...");
  const productCardRaw = buildProductCardChunks(
    await productAdapter.getProduct(productId),
  );
  const productCardEnriched = enrichChunks(productCardRaw);
  log(
    verbose,
    `  Product card chunks: ${productCardEnriched.length} (from ${productId}.json)`,
  );

  const allChunks = [...contextualChunks, ...productCardEnriched];

  // Step 4: Store in MongoDB with embeddings
  log(verbose, "Generating embeddings and storing in MongoDB...");
  const db = await getDb();
  const insertedCount = await insertChunks(db, allChunks, productId);
  log(verbose, `  Stored ${insertedCount} chunks with embeddings`);

  // Step 5: Create vector search index
  log(verbose, "Creating vector search index...");
  await createVectorIndex(db);
  log(verbose, "  Vector search index created (or already exists)");

  // Step 6: Regenerate seed questions against the fresh embeddings
  // Source documents just changed — derived caches must be invalidated.
  // See docs/production-scaling/ingestion.md.
  log(verbose, "Regenerating seed questions...");
  let seedQuestionsCount = 0;
  try {
    seedQuestionsCount = await regenerateSeedQuestions(
      productId,
      verbose,
      markdown,
    );
  } catch (error) {
    log(
      verbose,
      `  Seed-question regeneration failed — cache left empty, widget will serve fallback until next attempt. Error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return {
    chunksCreated: insertedCount,
    productId,
    markdownCached: cached,
    seedQuestionsCount,
  };
}

/**
 * Runs a simple verification query against the vector store.
 */
export async function verifyIngestion(
  productId: string = DEFAULT_PRODUCT_ID,
): Promise<void> {
  const db = await getDb();
  const testQueries = [
    "How do I clean the filter?",
    "What is the suction power?",
    "How to set up the base station?",
  ];

  console.log("\nVerification queries:");
  for (const query of testQueries) {
    // Atlas Vector Search indexes inserts asynchronously — retry briefly
    // so verification right after ingestion doesn't see 0 results during catchup.
    let results: Awaited<ReturnType<typeof similaritySearch>> = [];
    const maxAttempts = 5;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      results = await similaritySearch(db, query, {
        productId,
        topK: 3,
        minScore: 0.3,
      });
      if (results.length > 0) break;
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    console.log(`\n  Q: "${query}"`);
    console.log(`  Found ${results.length} results:`);
    for (const r of results) {
      console.log(
        `    [${r.score.toFixed(3)}] ${r.metadata.sectionHeader} (p${r.metadata.pageNumbers.join(",")}) — "${r.text.substring(0, 80)}..."`,
      );
    }
  }
}

function printBanner(pdfPath: string, productId: string, config: ChunkConfig) {
  let pdfSize = "unknown";
  try {
    const bytes = statSync(pdfPath).size;
    pdfSize = `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  } catch {
    // PDF missing — will fail in extraction step with a clearer error
  }
  const mongoUri = process.env.MONGODB_URI
    ? process.env.MONGODB_URI.replace(/\/\/[^@]+@/, "//***@")
    : "mongodb://localhost:27017 (default)";
  const langsmithEnabled = process.env.LANGSMITH_TRACING === "true";

  console.log("=".repeat(70));
  console.log("  Product Insights — Ingestion Pipeline");
  console.log("=".repeat(70));
  console.log(`  Product:          ${productId}`);
  console.log(`  PDF:              ${basename(pdfPath)} (${pdfSize})`);
  console.log(`  MongoDB:          ${mongoUri}`);
  console.log(
    `  LangSmith:        ${langsmithEnabled ? `enabled (project: ${process.env.LANGSMITH_PROJECT ?? "product-insights-agent"})` : "disabled"}`,
  );
  console.log(`  Node:             ${process.version}`);
  console.log("");
  console.log("  Models");
  console.log(`    Extraction:     ${EXTRACTION_MODEL}`);
  console.log(
    `    Embedding:      ${EMBEDDING_MODEL} (${EMBEDDING_DIMENSIONS} dims)`,
  );
  console.log("");
  console.log("  Chunking");
  console.log(`    chunkSize:      ${config.chunkSize} tokens`);
  console.log(`    overlap:        ${config.overlap} tokens`);
  console.log(`    minChunkSize:   ${config.minChunkSize} tokens`);
  console.log("");
  console.log("  Contextual Retrieval: enabled");
  console.log(`    Context model:  ${CONTEXT_MODEL}`);
  console.log("    Prompt caching: on (document prefix)");
  console.log("=".repeat(70));
  console.log("");
}

// CLI entry point
async function main() {
  const verbose = !process.argv.includes("--quiet");
  const verify = process.argv.includes("--verify");
  const forceExtract = process.argv.includes("--force");

  try {
    printBanner(DEFAULT_PDF_PATH, DEFAULT_PRODUCT_ID, DEFAULT_CHUNK_CONFIG);
    const startTime = Date.now();
    console.log("Starting ingestion pipeline...\n");
    const result = await ingest({ verbose, forceExtract });
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log("\n--- Ingestion Complete ---");
    console.log(
      `  Extraction: ${result.markdownCached ? "cached" : "fresh (Gemini)"}`,
    );
    console.log(`  Chunks: ${result.chunksCreated}`);
    console.log(`  Seed questions: ${result.seedQuestionsCount}`);
    console.log(`  Product: ${result.productId}`);
    console.log(`  Elapsed: ${elapsed}s`);

    if (verify) {
      await verifyIngestion(result.productId);
    }

    process.exit(0);
  } catch (error) {
    console.error("Ingestion failed:", error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
