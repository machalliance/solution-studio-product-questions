import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { config } from "@/server/config";

// Only `generateText` is mocked — the real LLM endpoint can't be hit from a
// unit test. The real `ai.Output.object(...)` helper, the real zod schema, and
// the real `pullPrompt` fallback path all run unmodified so we actually
// exercise the experimental_output branch and the hub integration.
const generateTextMock = vi.fn();

vi.mock("@/server/observability/tracing", () => ({
  getTracedAI: () => ({ generateText: generateTextMock, streamText: vi.fn() }),
  isTracingEnabled: () => false,
  traceFunction: <F>(fn: F) => fn,
  flushTraces: vi.fn(),
  getLangSmithClient: vi.fn(),
  attachRunMetadata: vi.fn(),
}));

import {
  classifyForEscalation,
  getEscalationMessage,
  SENSITIVE_CATEGORIES,
} from "./escalation";

describe("getEscalationMessage", () => {
  it("returns the generic escalation message for non-incident categories", () => {
    for (const category of SENSITIVE_CATEGORIES) {
      if (category === "safety-incident") continue;
      expect(getEscalationMessage(category)).toBe(config.escalation.message);
    }
  });

  it("returns a distinct safety-incident message with empathy, human handoff, and a contact channel", () => {
    const message = getEscalationMessage("safety-incident");
    expect(message).toBe(config.escalation.safetyIncidentMessage);
    expect(message).not.toBe(config.escalation.message);
    // Empathy
    expect(message.toLowerCase()).toMatch(/sorry|hope/);
    // Explicit human handoff
    expect(message.toLowerCase()).toContain("customer support");
    // Real contact channel (phone + email)
    expect(message).toContain("1-800-555-0199");
    expect(message).toContain("support@megabuy.example");
  });
});

describe("classifyForEscalation", () => {
  beforeEach(() => {
    generateTextMock.mockReset();
  });

  it("returns escalated=false when the classifier marks the question as not sensitive", async () => {
    generateTextMock.mockResolvedValueOnce({
      experimental_output: {
        isSensitive: false,
        category: "none",
        reasoning: "Routine product question",
      },
    });

    const result = await classifyForEscalation("How do I clean the filter?");
    expect(result).toEqual({ escalated: false });
    expect(generateTextMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed on missing structured output — escalates with the generic support message (no retry)", async () => {
    // Parse failure is deterministic; retrying with identical input won't
    // help. Verify we fail closed immediately without a second call.
    generateTextMock.mockResolvedValueOnce({ experimental_output: undefined });

    const result = await classifyForEscalation("anything");
    expect(result.escalated).toBe(true);
    expect(result.failed).toBe(true);
    expect(result.failReason).toBe("parse");
    expect(result.category).toBe("unknown");
    expect(result.message).toBe(config.escalation.message);
    expect(generateTextMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed on generateText throw — retries once, then escalates", async () => {
    generateTextMock.mockRejectedValueOnce(new Error("provider down"));
    generateTextMock.mockRejectedValueOnce(new Error("provider still down"));

    const result = await classifyForEscalation("anything");
    expect(generateTextMock).toHaveBeenCalledTimes(2);
    expect(result.escalated).toBe(true);
    expect(result.failed).toBe(true);
    expect(result.failReason).toBe("error");
    expect(result.message).toBe(config.escalation.message);
  });

  it("succeeds on retry after first failure", async () => {
    generateTextMock.mockRejectedValueOnce(new Error("transient"));
    generateTextMock.mockResolvedValueOnce({
      experimental_output: {
        isSensitive: true,
        category: "warranty-claim",
        reasoning: "User asks about warranty.",
      },
    });

    const result = await classifyForEscalation("warranty question");
    expect(generateTextMock).toHaveBeenCalledTimes(2);
    expect(result.escalated).toBe(true);
    expect(result.failed).toBeUndefined();
    expect(result.category).toBe("warranty-claim");
  });

  describe("timeout", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("fails closed on timeout — aborts via AbortSignal and retries once", async () => {
      // generateText honors abortSignal by rejecting with an AbortError when
      // the signal fires. Simulate that so we exercise the timeout branch.
      generateTextMock.mockImplementation(
        ({ abortSignal }: { abortSignal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            abortSignal?.addEventListener("abort", () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            });
          }),
      );

      const promise = classifyForEscalation("anything");
      // Advance past both attempts' timeouts (1500ms each).
      await vi.advanceTimersByTimeAsync(1600);
      await vi.advanceTimersByTimeAsync(1600);
      const result = await promise;

      expect(generateTextMock).toHaveBeenCalledTimes(2);
      expect(result.escalated).toBe(true);
      expect(result.failed).toBe(true);
      expect(result.failReason).toBe("timeout");
      expect(result.message).toBe(config.escalation.message);
    });
  });

  it("returns escalated=true with category, message, and reasoning for sensitive questions", async () => {
    generateTextMock.mockResolvedValueOnce({
      experimental_output: {
        isSensitive: true,
        category: "warranty-claim",
        reasoning: "User explicitly asks to file a warranty claim.",
      },
    });

    const result = await classifyForEscalation(
      "I want to file a warranty claim for my broken unit",
    );
    expect(result.escalated).toBe(true);
    expect(result.category).toBe("warranty-claim");
    expect(result.reasoning).toContain("warranty claim");
    expect(result.message).toBe(config.escalation.message);
  });

  it("maps every sensitive category to its configured escalation message", async () => {
    for (const category of SENSITIVE_CATEGORIES) {
      generateTextMock.mockResolvedValueOnce({
        experimental_output: {
          isSensitive: true,
          category,
          reasoning: `flagged as ${category}`,
        },
      });

      const result = await classifyForEscalation(`test input for ${category}`);
      expect(result.escalated).toBe(true);
      expect(result.category).toBe(category);
      const expected =
        category === "safety-incident"
          ? config.escalation.safetyIncidentMessage
          : config.escalation.message;
      expect(result.message).toBe(expected);
    }
  });

  it("passes the user question through to the classifier model", async () => {
    generateTextMock.mockResolvedValueOnce({
      experimental_output: {
        isSensitive: false,
        category: "none",
        reasoning: "ok",
      },
    });

    await classifyForEscalation("Can you match Amazon's price?");
    const call = generateTextMock.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect(call.model).toBe("openai/gpt-5-nano");
    expect(call.messages[0].content).toContain("Can you match Amazon's price?");
    expect(call.system).toContain("content classifier");
    expect(call.providerOptions?.openai?.reasoningEffort).toBe("minimal");
  });

  it("escalates 'the robot killed my dog' as a safety-incident with empathy + human handoff + contact channel", async () => {
    // Reproduction case from product-insights-agent-1k3. The classifier must
    // route harm reports to `safety-incident` (not `safety-hazard`), and the
    // response must acknowledge the harm, hand off to a human, and give a
    // real contact channel — never attempt to troubleshoot or close the
    // thread on "I don't have info".
    generateTextMock.mockResolvedValueOnce({
      experimental_output: {
        isSensitive: true,
        category: "safety-incident",
        reasoning: "User reports actual harm: death of a pet.",
      },
    });

    const result = await classifyForEscalation("the robot killed my dog");

    expect(result.escalated).toBe(true);
    expect(result.category).toBe("safety-incident");
    expect(result.message).toBe(config.escalation.safetyIncidentMessage);
    expect(result.message).not.toBe(config.escalation.message);
    expect(result.message?.toLowerCase()).toMatch(/sorry|hope/);
    expect(result.message?.toLowerCase()).toContain("customer support");
    expect(result.message).toContain("1-800-555-0199");
  });

  it("uses the in-repo classifier prompt which teaches every SENSITIVE_CATEGORIES value", async () => {
    // The zod enum (SENSITIVE_CATEGORIES) and the category list inside the
    // classifier prompt must stay in sync — if the prompt doesn't teach the
    // model a category, it cannot return it and we silently fall through to
    // the un-escalated answer path. Assert every category is mentioned.
    generateTextMock.mockResolvedValueOnce({
      experimental_output: {
        isSensitive: false,
        category: "none",
        reasoning: "ok",
      },
    });

    await classifyForEscalation("What color is the product?");
    const call = generateTextMock.mock.calls[0]?.[0];
    expect(call.system).toContain("content classifier");
    for (const category of SENSITIVE_CATEGORIES) {
      expect(call.system).toContain(category);
    }
    expect(call.system).toContain("Examples of");
  });
});
