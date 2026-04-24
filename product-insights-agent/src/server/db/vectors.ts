import { embed, embedMany } from "ai";
import type { Db, Collection } from "mongodb";
import type { EnrichedChunk, ChunkMetadata } from "@/tooling/pipeline/metadata";

export const EMBEDDING_MODEL = "openai/text-embedding-3-small";
export const EMBEDDING_DIMENSIONS = 1536;
const COLLECTION_NAME = "chunks";
const INDEX_NAME = "vector_index";

export interface StoredChunk {
  /** Original chunk body. Returned to the runtime LLM answer path as-is. */
  text: string;
  /**
   * 1–2 sentence context header prepended to `text` before embedding.
   * Persisted for debugging/observability; never shown to the runtime answerer.
   * Empty string when contextual retrieval is disabled or failed for this chunk.
   */
  context: string;
  embedding: number[];
  metadata: ChunkMetadata;
  productId: string;
  createdAt: Date;
}

export interface SimilarityResult {
  text: string;
  /**
   * Contextual Retrieval header stored alongside each chunk. Optional because
   * older documents and feedback-loop inserts may not have one. The runtime
   * answer path (chat route, retrieval helper) must ignore this field — it's
   * tuned for retrieval, not generation. Non-answer-path consumers (e.g. the
   * seed-question validator) benefit from reading it.
   */
  context?: string;
  metadata: ChunkMetadata;
  score: number;
}

/**
 * Generates embeddings for an array of text values using text-embedding-3-small.
 * Returns embeddings in the same order as the input values.
 */
export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  const { embeddings } = await embedMany({
    model: EMBEDDING_MODEL,
    values: texts,
    maxParallelCalls: 5,
  });
  return embeddings;
}

/**
 * Generates a single embedding for a text value.
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const { embedding } = await embed({
    model: EMBEDDING_MODEL,
    value: text,
  });
  return embedding;
}

/**
 * Creates the MongoDB vector search index on the chunks collection.
 * This is idempotent — if the index already exists, it's a no-op.
 */
export async function createVectorIndex(db: Db): Promise<void> {
  const collection = db.collection(COLLECTION_NAME);

  // Check if index already exists
  const indexes = await collection
    .listSearchIndexes(INDEX_NAME)
    .toArray()
    .catch(() => []);

  if (indexes.length > 0) return;

  await collection.createSearchIndex({
    name: INDEX_NAME,
    type: "vectorSearch",
    definition: {
      fields: [
        {
          type: "vector",
          path: "embedding",
          numDimensions: EMBEDDING_DIMENSIONS,
          similarity: "cosine",
        },
        {
          type: "filter",
          path: "productId",
        },
      ],
    },
  });
}

/**
 * Returns the chunks collection.
 */
export function getChunksCollection(db: Db): Collection<StoredChunk> {
  return db.collection<StoredChunk>(COLLECTION_NAME);
}

/**
 * Inserts enriched chunks with their embeddings into MongoDB.
 * Generates embeddings in batch, then bulk-inserts all documents.
 */
export async function insertChunks(
  db: Db,
  chunks: EnrichedChunk[],
  productId: string,
): Promise<number> {
  if (chunks.length === 0) return 0;

  // Embed the contextualized text (context + body) so retrieval benefits from
  // Contextual Retrieval. Persist the raw `text` and `context` separately so
  // the runtime answer path reads the original body only.
  const embeddingInputs = chunks.map((c) => c.embeddingInput);
  const embeddings = await generateEmbeddings(embeddingInputs);
  const now = new Date();

  const documents: StoredChunk[] = chunks.map((chunk, i) => ({
    text: chunk.text,
    context: chunk.context,
    embedding: embeddings[i],
    metadata: chunk.metadata,
    productId,
    createdAt: now,
  }));

  const collection = getChunksCollection(db);

  // Clear existing chunks for this product before inserting
  await collection.deleteMany({ productId });

  const result = await collection.insertMany(documents);
  return result.insertedCount;
}

/**
 * Performs a vector similarity search against the chunks collection.
 * Returns the top-k most similar chunks to the query text.
 */
export async function similaritySearch(
  db: Db,
  query: string,
  options: {
    productId?: string;
    topK?: number;
    minScore?: number;
  } = {},
): Promise<SimilarityResult[]> {
  const { productId, topK = 5, minScore = 0.5 } = options;

  const queryEmbedding = await generateEmbedding(query);
  const collection = getChunksCollection(db);

  const filter: Record<string, unknown> = {};
  if (productId) {
    filter.productId = productId;
  }

  const pipeline = [
    {
      $vectorSearch: {
        index: INDEX_NAME,
        path: "embedding",
        queryVector: queryEmbedding,
        numCandidates: topK * 10,
        limit: topK,
        ...(Object.keys(filter).length > 0 ? { filter } : {}),
      },
    },
    {
      $addFields: {
        score: { $meta: "vectorSearchScore" },
      },
    },
    {
      $match: {
        score: { $gte: minScore },
      },
    },
    {
      $project: {
        text: 1,
        context: 1,
        metadata: 1,
        score: 1,
        _id: 0,
      },
    },
  ];

  const results = await collection.aggregate(pipeline).toArray();

  return results.map((doc) => ({
    text: doc.text as string,
    context: doc.context as string | undefined,
    metadata: doc.metadata as ChunkMetadata,
    score: doc.score as number,
  }));
}
