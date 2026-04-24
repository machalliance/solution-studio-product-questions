import type { RawChunk } from "./chunk";
import type { ProductData } from "@/server/product/types";

/**
 * Builds a small set of "product card" chunks from structured product data.
 * One chunk per logical section so retrieval can surface the matching slice
 * (identity / description / features / specifications) without dragging in
 * unrelated text. These chunks answer product-shape questions (price, suction
 * power, model number) that the PDF manual may not mention.
 *
 * Section headers are prefixed with "Product Card —" so they're visually
 * distinguishable in retrieval traces and so metadata detection can route
 * them to the "product-card" topic.
 */
export function buildProductCardChunks(product: ProductData): RawChunk[] {
  const formattedPrice = formatPrice(product.price, product.currency);
  const chunks: RawChunk[] = [];
  let index = 0;

  const identityLines = [
    `Name: ${product.name}`,
    `Brand: ${product.brand}`,
    `Model: ${product.model}`,
    `Category: ${product.category}`,
    `Price: ${formattedPrice}`,
  ];
  if (product.url) identityLines.push(`Product page: ${product.url}`);
  chunks.push({
    text: identityLines.join("\n"),
    pageNumbers: [],
    sectionHeader: "Product Card — Product Identity",
    index: index++,
  });

  if (product.description?.trim()) {
    chunks.push({
      text: product.description.trim(),
      pageNumbers: [],
      sectionHeader: "Product Card — Product Description",
      index: index++,
    });
  }

  if (product.features?.length > 0) {
    const featureLines = product.features.map((f) => `- ${f}`).join("\n");
    chunks.push({
      text: `Key features of the ${product.name}:\n${featureLines}`,
      pageNumbers: [],
      sectionHeader: "Product Card — Product Features",
      index: index++,
    });
  }

  const specEntries = Object.entries(product.specifications ?? {});
  if (specEntries.length > 0) {
    const specLines = specEntries.map(([k, v]) => `- ${k}: ${v}`).join("\n");
    chunks.push({
      text: `Technical specifications for the ${product.name}:\n${specLines}`,
      pageNumbers: [],
      sectionHeader: "Product Card — Product Specifications",
      index: index++,
    });
  }

  return chunks;
}

function formatPrice(price: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-CA", {
      style: "currency",
      currency,
    }).format(price);
  } catch {
    return `${price} ${currency}`;
  }
}
