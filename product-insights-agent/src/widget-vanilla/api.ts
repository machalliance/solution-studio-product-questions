import type { SeedQuestion, SeedQuestionsSource } from "./types";

export interface FetchSeedQuestionsResult {
  questions: SeedQuestion[];
  source: SeedQuestionsSource;
}

export async function fetchSeedQuestions(
  apiBase: string,
  productId: string,
  clickedIds: string[],
  secret?: string,
): Promise<FetchSeedQuestionsResult> {
  const clickedParam =
    clickedIds.length > 0 ? `&clicked=${clickedIds.join(",")}` : "";
  const url = `${apiBase}/api/seed-questions?productId=${encodeURIComponent(productId)}${clickedParam}`;
  const headers: Record<string, string> = {};
  if (secret) headers["Authorization"] = `Bearer ${secret}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`seed-questions ${res.status}`);
  const data = await res.json();
  const source: SeedQuestionsSource =
    data.source === "cache" ||
    data.source === "fallback" ||
    data.source === "fresh"
      ? data.source
      : "unknown";
  return { questions: data.questions as SeedQuestion[], source };
}
