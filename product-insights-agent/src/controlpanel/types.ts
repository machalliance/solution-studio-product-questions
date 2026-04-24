export interface EventEntry {
  time: string;
  type: string;
  data?: unknown;
}

export const PRESET_PRODUCTS: { id: string; name: string }[] = [
  { id: "dreame-x40-ultra", name: "Dreame X40 Ultra" },
];
