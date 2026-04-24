import { readFileSync, existsSync } from "fs";
import { NextResponse } from "next/server";
import { buildCorsHeaders } from "@/server/cors";
import { checkEmbedAuth } from "@/server/auth";

const CORS_METHODS = "GET, OPTIONS";

export function OPTIONS(req: Request) {
  return new Response(null, {
    status: 204,
    headers: buildCorsHeaders(req, { methods: CORS_METHODS }),
  });
}
import { config } from "@/server/config";
import { getDb } from "@/server/db/client";
import {
  readCache,
  writeCache,
  createSeedQuestion,
} from "@/server/seed-questions/cache";
import { selectQuestions } from "@/server/seed-questions/rotation";
import { generateSeedQuestions } from "@/server/seed-questions/generate";
import { FileProductDataAdapter } from "@/server/product/file-adapter";
import { markdownCachePath } from "@/tooling/pipeline/extract-markdown";
import type { SeedQuestion } from "@/server/seed-questions/types";

const productAdapter = new FileProductDataAdapter();

/**
 * Returns seed questions for the widget.
 * - Reads from MongoDB cache if available
 * - Falls back to hardcoded questions immediately
 * - Triggers background generation if cache is empty/stale
 *
 * Query params:
 *   - clicked: comma-separated list of previously clicked question IDs
 */
export async function GET(req: Request) {
  const corsHeaders = buildCorsHeaders(req, { methods: CORS_METHODS });

  const authFailure = checkEmbedAuth(req);
  if (authFailure) {
    return NextResponse.json(authFailure.body, {
      status: authFailure.status,
      headers: corsHeaders,
    });
  }

  const url = new URL(req.url);
  const clickedParam = url.searchParams.get("clicked") || "";
  const clickedIds = clickedParam
    ? clickedParam.split(",").filter(Boolean)
    : [];
  const productIdParam = url.searchParams.get("productId")?.trim();
  const productId = productIdParam || config.product.defaultProductId;
  const displayCount = config.seedQuestions.displayCount;

  try {
    const db = await getDb();
    const cached = await readCache(db, productId);

    // Cache must hold enough questions to fill the widget. A partial cache
    // (e.g. from a prior run where validation dropped most candidates) is
    // treated as a miss so we fall through to fallback + regeneration.
    if (cached && cached.length >= displayCount) {
      const selected = selectQuestions(cached, clickedIds, displayCount);
      return NextResponse.json(
        { questions: selected, source: "cache", productId },
        { headers: corsHeaders },
      );
    }
  } catch {
    // MongoDB unavailable — fall through to fallback
  }

  // Return fallback questions immediately
  const fallbackQuestions: SeedQuestion[] = config.seedQuestions.fallback.map(
    (text) => createSeedQuestion(text, productId),
  );
  const selected = selectQuestions(fallbackQuestions, clickedIds, displayCount);

  // Trigger background generation (fire-and-forget). Also runs when the
  // cache exists but is undersized so we self-heal from a bad prior write.
  triggerBackgroundGeneration(productId).catch(() => {
    // Silently ignore background generation failures
  });

  return NextResponse.json(
    { questions: selected, source: "fallback", productId },
    { headers: corsHeaders },
  );
}

/**
 * Generates seed questions in the background and caches them.
 */
async function triggerBackgroundGeneration(productId: string): Promise<void> {
  const product = await productAdapter.getProduct(productId);

  // Generator reads the full manual; the validator inside generateSeedQuestions
  // does per-candidate runtime retrieval, so there's nothing to prefetch here.
  const markdownPath = markdownCachePath(productId);
  if (!existsSync(markdownPath)) return;
  const markdown = readFileSync(markdownPath, "utf-8");

  const questions = await generateSeedQuestions(
    product,
    markdown,
    config.seedQuestions.totalGenerated,
  );

  // Only write if we got enough to fill the widget. A partial write would
  // satisfy `cached.length >= displayCount` on the next request and prevent
  // the route from retrying generation, leaving the widget permanently short.
  if (questions.length >= config.seedQuestions.displayCount) {
    const db = await getDb();
    await writeCache(db, productId, questions);
  }
}
