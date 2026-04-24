"use client";

import { PRESET_PRODUCTS } from "./types";

interface Props {
  productId: string;
  onProductIdChange: (id: string) => void;
}

export function ProductSelector({ productId, onProductIdChange }: Props) {
  const isPreset = PRESET_PRODUCTS.some((p) => p.id === productId);

  return (
    <div className="mb-6 rounded-lg bg-white p-4 shadow-md">
      <h2 className="mb-3 font-semibold text-zinc-900">Select Product</h2>

      <div className="mb-4 space-y-2">
        {PRESET_PRODUCTS.map((product) => {
          const active = productId === product.id;
          return (
            <button
              key={product.id}
              type="button"
              onClick={() => onProductIdChange(product.id)}
              className={`w-full rounded px-3 py-2 text-left text-sm transition-colors ${
                active
                  ? "border border-blue-200 bg-blue-100 text-blue-700"
                  : "bg-zinc-50 text-zinc-700 hover:bg-zinc-100"
              }`}
            >
              {product.name}
            </button>
          );
        })}
      </div>

      <div className="border-t pt-4">
        <label
          htmlFor="custom-product-id"
          className="mb-2 block text-sm text-zinc-600"
        >
          Or enter a custom productId:
        </label>
        <input
          id="custom-product-id"
          type="text"
          value={isPreset ? "" : productId}
          onChange={(e) => onProductIdChange(e.target.value.trim())}
          placeholder="e.g. dreame-x40-ultra"
          className="w-full rounded border bg-white px-3 py-2 text-sm text-zinc-900"
        />
      </div>

      <div className="mt-4 rounded bg-zinc-50 p-3 text-xs text-zinc-600">
        <strong>Active productId:</strong>
        <br />
        <code className="break-all text-blue-600">
          {productId || "(empty)"}
        </code>
      </div>
    </div>
  );
}
