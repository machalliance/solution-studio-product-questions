import type { SeedQuestion } from "./types";

/**
 * Selects questions for display, excluding any previously clicked question IDs.
 * Returns up to `count` questions, cycling through available ones.
 * If all questions have been clicked, wraps around and starts from the beginning.
 */
export function selectQuestions(
  allQuestions: SeedQuestion[],
  clickedIds: string[],
  count: number,
): SeedQuestion[] {
  if (allQuestions.length === 0) return [];

  const clickedSet = new Set(clickedIds);

  // Filter out clicked questions
  const available = allQuestions.filter((q) => !clickedSet.has(q.id));

  // If we have enough unclicked questions, return the first `count`
  if (available.length >= count) {
    return available.slice(0, count);
  }

  // If not enough unclicked questions remain, wrap around:
  // first use all available, then fill from the full pool
  if (available.length > 0) {
    const remaining = count - available.length;
    const wrapped = allQuestions
      .filter((q) => clickedSet.has(q.id))
      .slice(0, remaining);
    return [...available, ...wrapped];
  }

  // All questions have been clicked — cycle from the start
  return allQuestions.slice(0, count);
}
