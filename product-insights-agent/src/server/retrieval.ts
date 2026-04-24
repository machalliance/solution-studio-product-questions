import { getDb } from "./db/client";
import { similaritySearch, type SimilarityResult } from "./db/vectors";
import { config } from "./config";

export interface RetrievalOptions {
  productId?: string;
  topK?: number;
  minScore?: number;
}

/**
 * Retrieves relevant chunks from the vector store for a given query.
 * Returns chunks sorted by relevance score (highest first).
 */
export async function retrieveChunks(
  query: string,
  options: RetrievalOptions = {},
): Promise<SimilarityResult[]> {
  const {
    productId = config.product.defaultProductId,
    topK = 5,
    minScore = 0.5,
  } = options;

  const db = await getDb();
  const results = await similaritySearch(db, query, {
    productId,
    topK,
    minScore,
  });

  return results;
}
