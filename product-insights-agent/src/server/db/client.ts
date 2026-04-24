import { MongoClient, type Db } from "mongodb";

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017";
const DB_NAME = "product-insights";

let cachedClient: MongoClient | null = null;
let cachedDb: Db | null = null;

export async function getMongoClient(): Promise<MongoClient> {
  if (cachedClient) {
    return cachedClient;
  }

  const client = new MongoClient(MONGODB_URI, {
    serverSelectionTimeoutMS: 3000,
    connectTimeoutMS: 3000,
  });
  await client.connect();
  cachedClient = client;
  return client;
}

export async function getDb(): Promise<Db> {
  if (cachedDb) {
    return cachedDb;
  }

  const client = await getMongoClient();
  cachedDb = client.db(DB_NAME);
  return cachedDb;
}

export async function checkConnection(): Promise<{
  connected: boolean;
  error?: string;
}> {
  try {
    const client = new MongoClient(MONGODB_URI, {
      serverSelectionTimeoutMS: 3000,
      connectTimeoutMS: 3000,
    });
    await client.connect();
    await client.db("admin").command({ ping: 1 });
    await client.close();
    return { connected: true };
  } catch (error) {
    return {
      connected: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
