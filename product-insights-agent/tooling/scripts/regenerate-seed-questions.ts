import { readFileSync, existsSync } from "fs";
import { config } from "@/server/config";
import { getDb } from "@/server/db/client";
import { clearCache, writeCache } from "@/server/seed-questions/cache";
import { generateSeedQuestions } from "@/server/seed-questions/generate";
import { FileProductDataAdapter } from "@/server/product/file-adapter";
import { markdownCachePath } from "@/tooling/pipeline/extract-markdown";

export async function regenerateSeedQuestions(
  productId: string = config.product.defaultProductId,
  verbose = true,
  markdownOverride?: string,
): Promise<number> {
  const log = (...args: unknown[]) => {
    if (verbose) console.log(...args);
  };

  log(`Regenerating seed questions for product: ${productId}`);

  const db = await getDb();

  log("  Clearing existing cache entry...");
  await clearCache(db, productId);

  let markdown = markdownOverride;
  if (!markdown) {
    const path = markdownCachePath(productId);
    if (!existsSync(path)) {
      throw new Error(
        `No cached Markdown for product "${productId}" at ${path}. Run the ingest pipeline first.`,
      );
    }
    markdown = readFileSync(path, "utf-8");
  }
  log(`  Loaded manual (${markdown.length} characters)`);

  const productAdapter = new FileProductDataAdapter();
  const product = await productAdapter.getProduct(productId);

  log(
    `  Generating ${config.seedQuestions.totalGenerated} candidate questions...`,
  );
  const questions = await generateSeedQuestions(
    product,
    markdown,
    config.seedQuestions.totalGenerated,
  );

  if (questions.length === 0) {
    throw new Error(
      "Generation returned 0 answerable questions — not writing cache.",
    );
  }

  log(`  Writing ${questions.length} validated questions to cache...`);
  await writeCache(db, productId, questions);

  log(`Done. Cached ${questions.length} questions for "${productId}".`);
  return questions.length;
}

async function main() {
  const productId =
    process.argv[2] && !process.argv[2].startsWith("--")
      ? process.argv[2]
      : config.product.defaultProductId;

  try {
    const count = await regenerateSeedQuestions(productId);
    if (count < config.seedQuestions.displayCount) {
      console.warn(
        `\nWarning: only ${count} answerable questions survived validation (need ${config.seedQuestions.displayCount} to fill the widget).`,
      );
    }
    process.exit(0);
  } catch (error) {
    console.error("Seed-question regeneration failed:", error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
