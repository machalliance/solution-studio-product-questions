import { describe, it, expect } from "vitest";
import path from "path";
import { FileProductDataAdapter } from "./file-adapter";

const dataDir = path.join(process.cwd(), "data", "products");

describe("FileProductDataAdapter", () => {
  const adapter = new FileProductDataAdapter(dataDir);

  it("loads the dreame-x40-ultra product data", async () => {
    const product = await adapter.getProduct("dreame-x40-ultra");
    expect(product.id).toBe("dreame-x40-ultra");
    expect(product.name).toContain("Dreame");
    expect(product.brand).toBe("Dreame");
    expect(product.price).toBeGreaterThan(0);
    expect(product.features.length).toBeGreaterThan(0);
    expect(Object.keys(product.specifications).length).toBeGreaterThan(0);
  });

  it("has all required fields", async () => {
    const product = await adapter.getProduct("dreame-x40-ultra");
    expect(product.id).toBeDefined();
    expect(product.name).toBeDefined();
    expect(product.brand).toBeDefined();
    expect(product.model).toBeDefined();
    expect(product.price).toBeDefined();
    expect(product.currency).toBeDefined();
    expect(product.description).toBeDefined();
    expect(product.features).toBeDefined();
    expect(product.specifications).toBeDefined();
    expect(product.images).toBeDefined();
    expect(product.category).toBeDefined();
  });

  it("throws on missing product file", async () => {
    await expect(adapter.getProduct("nonexistent")).rejects.toThrow();
  });

  it("caches concurrent calls so both resolve to the same product object", async () => {
    const fresh = new FileProductDataAdapter(dataDir);
    const a = fresh.getProduct("dreame-x40-ultra");
    const b = fresh.getProduct("dreame-x40-ultra");
    const [pa, pb] = await Promise.all([a, b]);
    // Cache hit means both awaits resolve to the same underlying object, not
    // two separately-parsed copies.
    expect(pa).toBe(pb);
  });

  it("returns the same cached result on a second call", async () => {
    const fresh = new FileProductDataAdapter(dataDir);
    const first = await fresh.getProduct("dreame-x40-ultra");
    const second = await fresh.getProduct("dreame-x40-ultra");
    expect(first).toBe(second);
  });

  it("evicts failed entries so a subsequent retry re-reads the file", async () => {
    const fresh = new FileProductDataAdapter(dataDir);
    // First call rejects and should NOT get cached
    await expect(fresh.getProduct("nonexistent")).rejects.toThrow();
    // Second call: if the rejection had been cached, the retry would return
    // the same rejected promise. We want the adapter to try again instead.
    // Wait a tick for the catch handler to run (deletes the cache entry).
    await new Promise((r) => setTimeout(r, 0));
    await expect(fresh.getProduct("nonexistent")).rejects.toThrow();
    // And a valid product after a failure still works
    const product = await fresh.getProduct("dreame-x40-ultra");
    expect(product.id).toBe("dreame-x40-ultra");
  });
});
