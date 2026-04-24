import { describe, it, expect } from "vitest";
import { checkPostResponse } from "./post-check";

describe("checkPostResponse", () => {
  describe("competitor mentions", () => {
    it("flags responses mentioning competitor brands", () => {
      const competitors = [
        "Roomba",
        "iRobot",
        "Roborock",
        "Ecovacs",
        "Shark",
        "Samsung",
        "Dyson",
        "Eufy",
        "Xiaomi",
      ];

      for (const brand of competitors) {
        const result = checkPostResponse(
          `This product is better than the ${brand} model.`,
        );
        expect(result.passed, `Should flag competitor mention: ${brand}`).toBe(
          false,
        );
        expect(result.violations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: "competitor-mention",
              detail: expect.stringContaining(brand.toLowerCase()),
            }),
          ]),
        );
      }
    });

    it("passes responses without competitor mentions", () => {
      const response =
        "The Dreame X40 Ultra has 12,000Pa suction power and supports both vacuuming and mopping.";
      const result = checkPostResponse(response);
      const competitorViolations = result.violations.filter(
        (v) => v.type === "competitor-mention",
      );
      expect(competitorViolations).toHaveLength(0);
    });
  });

  describe("unsupported safety claims", () => {
    it("flags absolute safety guarantees", () => {
      const inputs = [
        "This product is guaranteed safe for all surfaces.",
        "There is 100% safe operation in all conditions.",
        "There is no risk of any damage whatsoever.",
        "There is zero danger when using this product.",
        "This product will not cause any harm to your floors.",
        "This device cannot catch fire under any circumstances.",
      ];

      for (const input of inputs) {
        const result = checkPostResponse(input);
        const safetyViolations = result.violations.filter(
          (v) => v.type === "unsupported-safety-claim",
        );
        expect(
          safetyViolations.length,
          `Should flag unsupported safety claim: "${input}"`,
        ).toBeGreaterThan(0);
      }
    });

    it("passes responses with factual safety information", () => {
      const response =
        "According to the manual, the device has overheat protection and will shut down automatically if it detects abnormal temperatures.";
      const result = checkPostResponse(response);
      const safetyViolations = result.violations.filter(
        (v) => v.type === "unsupported-safety-claim",
      );
      expect(safetyViolations).toHaveLength(0);
    });
  });

  describe("length constraints", () => {
    it("flags responses exceeding maximum length", () => {
      const longResponse = "a".repeat(4001);
      const result = checkPostResponse(longResponse);
      expect(result.passed).toBe(false);
      expect(result.violations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "length-exceeded",
          }),
        ]),
      );
    });

    it("passes responses within maximum length", () => {
      const response = "a".repeat(4000);
      const result = checkPostResponse(response);
      const lengthViolations = result.violations.filter(
        (v) => v.type === "length-exceeded",
      );
      expect(lengthViolations).toHaveLength(0);
    });
  });

  describe("clean responses", () => {
    it("passes a clean, well-formed product response", () => {
      const response = `The Dreame X40 Ultra features a powerful 12,000Pa suction system that effectively picks up debris from multiple surface types including hardwood, tile, and carpet.

Key features include:
- Dual vacuum and mop functionality
- Automatic mop washing and drying
- LiDAR navigation for efficient cleaning paths
- App control for scheduling and zone cleaning

The battery lasts approximately 210 minutes on standard mode, which is typically sufficient for homes up to 300 square meters.`;

      const result = checkPostResponse(response);
      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });
  });

  describe("multiple violations", () => {
    it("reports all violations found in a single response", () => {
      const response = `This product is guaranteed safe and better than the Roomba. There is no risk at all. ${"x".repeat(4001)}`;
      const result = checkPostResponse(response);
      expect(result.passed).toBe(false);
      expect(result.violations.length).toBeGreaterThanOrEqual(3);

      const types = result.violations.map((v) => v.type);
      expect(types).toContain("competitor-mention");
      expect(types).toContain("unsupported-safety-claim");
      expect(types).toContain("length-exceeded");
    });
  });

  describe("competitor-mention substring behaviour", () => {
    // The current implementation uses String.includes() on lowercased text, so
    // any substring collision will flag. These tests lock in that behaviour so
    // a future switch to word-boundary matching is an intentional change, not
    // an accidental drift.
    it("flags competitor substrings inside a longer word (known over-match)", () => {
      const result = checkPostResponse(
        "The robot produced a roombaa-like vibration during docking.",
      );
      const competitorHits = result.violations.filter(
        (v) => v.type === "competitor-mention",
      );
      expect(competitorHits.length).toBeGreaterThan(0);
    });

    it("does not flag ordinary product language", () => {
      const response =
        "The Dreame X40 Ultra delivers strong suction and excellent navigation.";
      const competitorHits = checkPostResponse(response).violations.filter(
        (v) => v.type === "competitor-mention",
      );
      expect(competitorHits).toHaveLength(0);
    });

    it("catches multiple distinct competitor brands in one response", () => {
      const response =
        "Better than the Roomba and more capable than the Roborock.";
      const competitorHits = checkPostResponse(response).violations.filter(
        (v) => v.type === "competitor-mention",
      );
      expect(competitorHits.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("length boundary", () => {
    it("passes at 3999 chars", () => {
      const result = checkPostResponse("a".repeat(3999));
      const lengthHits = result.violations.filter(
        (v) => v.type === "length-exceeded",
      );
      expect(lengthHits).toHaveLength(0);
    });

    it("passes at exactly 4000 chars", () => {
      const result = checkPostResponse("a".repeat(4000));
      const lengthHits = result.violations.filter(
        (v) => v.type === "length-exceeded",
      );
      expect(lengthHits).toHaveLength(0);
    });

    it("flags at 4001 chars", () => {
      const result = checkPostResponse("a".repeat(4001));
      const lengthHits = result.violations.filter(
        (v) => v.type === "length-exceeded",
      );
      expect(lengthHits).toHaveLength(1);
    });
  });

  describe("competitor-mention false-positive sweep", () => {
    // Ordinary product language that must NOT trigger competitor detection.
    const benign = [
      "Use the dock to charge the unit overnight.",
      "The app offers scheduling and zone cleaning.",
      "Run the self-clean cycle once per week.",
      "The mop pads should be rinsed after each use.",
      "The base station empties the dustbin automatically.",
    ];

    for (const response of benign) {
      it(`does not flag: "${response}"`, () => {
        const hits = checkPostResponse(response).violations.filter(
          (v) => v.type === "competitor-mention",
        );
        expect(hits).toHaveLength(0);
      });
    }
  });
});
