import { describe, it, expect } from "vitest";
import { buildProductCardChunks } from "./product-card-chunks";
import type { ProductData } from "@/server/product/types";

const product: ProductData = {
  id: "test-product",
  name: "Test Robot Vac",
  brand: "Acme",
  model: "X1",
  price: 999.99,
  currency: "CAD",
  description: "A compact robot vacuum.",
  features: ["Feature A", "Feature B"],
  specifications: {
    "Suction Power": "5000Pa",
    Weight: "3kg",
  },
  images: [],
  category: "Robot Vacuums",
  url: "https://example.com/test-product",
};

describe("buildProductCardChunks", () => {
  it("produces one chunk per logical section with Product Card headers", () => {
    const chunks = buildProductCardChunks(product);

    expect(chunks.length).toBeGreaterThanOrEqual(4);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeGreaterThan(0);
      expect(chunk.sectionHeader).toMatch(/^Product Card/);
      expect(chunk.pageNumbers).toEqual([]);
    }
  });

  it("embeds price and model in the identity chunk", () => {
    const chunks = buildProductCardChunks(product);
    const identity = chunks.find((c) =>
      c.sectionHeader.includes("Product Identity"),
    );
    expect(identity).toBeDefined();
    expect(identity!.text).toContain("Test Robot Vac");
    expect(identity!.text).toContain("X1");
    expect(identity!.text).toContain("999");
    // en-CA CAD formatter renders "$999.99" (no "CAD" suffix). The fallback
    // path ("{price} {currency}") is the only one that keeps "CAD", and it
    // only fires when Intl throws — which isn't our case.
    expect(identity!.text).toMatch(/\$999\.99|CAD/);
  });

  it("includes specifications as key/value pairs", () => {
    const chunks = buildProductCardChunks(product);
    const specs = chunks.find((c) =>
      c.sectionHeader.includes("Specifications"),
    );
    expect(specs).toBeDefined();
    expect(specs!.text).toContain("Suction Power");
    expect(specs!.text).toContain("5000Pa");
  });

  it("lists features bulleted", () => {
    const chunks = buildProductCardChunks(product);
    const features = chunks.find((c) => c.sectionHeader.includes("Features"));
    expect(features).toBeDefined();
    expect(features!.text).toContain("Feature A");
    expect(features!.text).toContain("Feature B");
  });

  it("assigns sequential indexes", () => {
    const chunks = buildProductCardChunks(product);
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].index).toBe(i);
    }
  });

  it("skips empty sections gracefully", () => {
    const bare: ProductData = {
      ...product,
      description: "",
      features: [],
      specifications: {},
    };
    const chunks = buildProductCardChunks(bare);
    // Identity still emitted
    expect(chunks.length).toBe(1);
    expect(chunks[0].sectionHeader).toContain("Product Identity");
  });
});
