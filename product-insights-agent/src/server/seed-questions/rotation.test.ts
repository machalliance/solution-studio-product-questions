import { describe, it, expect } from "vitest";
import { selectQuestions } from "./rotation";
import type { SeedQuestion } from "./types";

function makeSeedQuestion(id: string, text: string): SeedQuestion {
  return {
    id,
    text,
    productId: "test-product",
    createdAt: new Date("2026-01-01"),
  };
}

const allQuestions: SeedQuestion[] = [
  makeSeedQuestion("q1", "What is the suction power?"),
  makeSeedQuestion("q2", "How does the mop work?"),
  makeSeedQuestion("q3", "What surfaces can it clean?"),
  makeSeedQuestion("q4", "How long does the battery last?"),
  makeSeedQuestion("q5", "How do I set it up?"),
];

describe("selectQuestions", () => {
  it("returns the requested count from all questions when none are clicked", () => {
    const result = selectQuestions(allQuestions, [], 3);
    expect(result).toHaveLength(3);
    expect(result[0].id).toBe("q1");
    expect(result[1].id).toBe("q2");
    expect(result[2].id).toBe("q3");
  });

  it("excludes clicked question IDs", () => {
    const result = selectQuestions(allQuestions, ["q1"], 3);
    expect(result).toHaveLength(3);
    expect(result.find((q) => q.id === "q1")).toBeUndefined();
    expect(result[0].id).toBe("q2");
    expect(result[1].id).toBe("q3");
    expect(result[2].id).toBe("q4");
  });

  it("excludes multiple clicked question IDs", () => {
    const result = selectQuestions(allQuestions, ["q1", "q2"], 3);
    expect(result).toHaveLength(3);
    expect(result.find((q) => q.id === "q1")).toBeUndefined();
    expect(result.find((q) => q.id === "q2")).toBeUndefined();
    expect(result[0].id).toBe("q3");
    expect(result[1].id).toBe("q4");
    expect(result[2].id).toBe("q5");
  });

  it("wraps around when not enough unclicked questions remain", () => {
    // 5 total, click 3, request 3: should get 2 unclicked + 1 clicked
    const result = selectQuestions(allQuestions, ["q1", "q2", "q3"], 3);
    expect(result).toHaveLength(3);
    expect(result[0].id).toBe("q4");
    expect(result[1].id).toBe("q5");
    // Third should be from the clicked pool
    expect(["q1", "q2", "q3"]).toContain(result[2].id);
  });

  it("cycles from the start when all questions are clicked", () => {
    const result = selectQuestions(
      allQuestions,
      ["q1", "q2", "q3", "q4", "q5"],
      3,
    );
    expect(result).toHaveLength(3);
    expect(result[0].id).toBe("q1");
    expect(result[1].id).toBe("q2");
    expect(result[2].id).toBe("q3");
  });

  it("returns empty array when no questions exist", () => {
    const result = selectQuestions([], [], 3);
    expect(result).toHaveLength(0);
  });

  it("returns fewer than requested if total questions are less than count", () => {
    const twoQuestions = allQuestions.slice(0, 2);
    const result = selectQuestions(twoQuestions, [], 3);
    expect(result).toHaveLength(2);
  });

  it("handles unknown clicked IDs gracefully", () => {
    const result = selectQuestions(allQuestions, ["nonexistent-id"], 3);
    expect(result).toHaveLength(3);
    expect(result[0].id).toBe("q1");
  });
});
