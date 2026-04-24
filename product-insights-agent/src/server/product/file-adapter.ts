import { readFile } from "fs/promises";
import path from "path";
import type { ProductData, ProductDataAdapter } from "./types";

export class FileProductDataAdapter implements ProductDataAdapter {
  private dataDir: string;
  private cache = new Map<string, Promise<ProductData>>();

  constructor(dataDir?: string) {
    this.dataDir = dataDir || path.join(process.cwd(), "data", "products");
  }

  async getProduct(productId: string): Promise<ProductData> {
    const cached = this.cache.get(productId);
    if (cached) return cached;

    const promise = (async () => {
      const filePath = path.join(this.dataDir, `${productId}.json`);
      const raw = await readFile(filePath, "utf-8");
      return JSON.parse(raw) as ProductData;
    })();

    this.cache.set(productId, promise);
    promise.catch(() => this.cache.delete(productId));
    return promise;
  }
}
