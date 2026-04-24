import type { Db } from "mongodb";
import type { SeedQuestion, SeedQuestionCache } from "./types";
import crypto from "crypto";

const COLLECTION_NAME = "seed_questions";

export function getCollection(db: Db) {
  return db.collection<SeedQuestionCache>(COLLECTION_NAME);
}

export async function readCache(
  db: Db,
  productId: string,
): Promise<SeedQuestion[] | null> {
  const collection = getCollection(db);
  const cached = await collection.findOne({ productId });
  if (!cached) return null;
  return cached.questions;
}

export async function writeCache(
  db: Db,
  productId: string,
  questions: SeedQuestion[],
): Promise<void> {
  const collection = getCollection(db);
  const cache: SeedQuestionCache = {
    productId,
    questions,
    createdAt: new Date(),
  };
  await collection.replaceOne({ productId }, cache, { upsert: true });
}

export async function clearCache(db: Db, productId: string): Promise<void> {
  const collection = getCollection(db);
  await collection.deleteMany({ productId });
}

export function createSeedQuestion(
  text: string,
  productId: string,
): SeedQuestion {
  return {
    id: crypto.randomUUID(),
    text,
    productId,
    createdAt: new Date(),
  };
}
