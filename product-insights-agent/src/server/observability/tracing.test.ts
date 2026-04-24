import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isTracingEnabled,
  getTracedAI,
  traceFunction,
  flushTraces,
  getLangSmithClient,
  hashUserInput,
} from "./tracing";

// Store original env
const originalEnv = { ...process.env };

beforeEach(() => {
  // Reset modules to clear singletons
  vi.resetModules();
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("isTracingEnabled", () => {
  it("returns true when LANGSMITH_TRACING=true and API key is set", () => {
    process.env.LANGSMITH_TRACING = "true";
    process.env.LANGSMITH_API_KEY = "lsv2_test_key";
    expect(isTracingEnabled()).toBe(true);
  });

  it("returns false when LANGSMITH_TRACING is not set", () => {
    delete process.env.LANGSMITH_TRACING;
    process.env.LANGSMITH_API_KEY = "lsv2_test_key";
    expect(isTracingEnabled()).toBe(false);
  });

  it("returns false when LANGSMITH_API_KEY is not set", () => {
    process.env.LANGSMITH_TRACING = "true";
    delete process.env.LANGSMITH_API_KEY;
    expect(isTracingEnabled()).toBe(false);
  });

  it("returns false when LANGSMITH_TRACING is not 'true'", () => {
    process.env.LANGSMITH_TRACING = "false";
    process.env.LANGSMITH_API_KEY = "lsv2_test_key";
    expect(isTracingEnabled()).toBe(false);
  });
});

describe("getTracedAI", () => {
  it("returns AI SDK methods when tracing is disabled", () => {
    delete process.env.LANGSMITH_TRACING;
    delete process.env.LANGSMITH_API_KEY;

    const traced = getTracedAI();
    expect(traced).toHaveProperty("generateText");
    expect(traced).toHaveProperty("streamText");
    expect(typeof traced.generateText).toBe("function");
    expect(typeof traced.streamText).toBe("function");
  });
});

describe("traceFunction", () => {
  it("returns the original function when tracing is disabled", () => {
    delete process.env.LANGSMITH_TRACING;
    delete process.env.LANGSMITH_API_KEY;

    const fn = (x: number) => x * 2;
    const traced = traceFunction(fn, { name: "double" });
    expect(traced(5)).toBe(10);
  });
});

describe("getLangSmithClient", () => {
  it("returns undefined when tracing is disabled", () => {
    delete process.env.LANGSMITH_TRACING;
    delete process.env.LANGSMITH_API_KEY;
    expect(getLangSmithClient()).toBeUndefined();
  });
});

describe("flushTraces", () => {
  it("resolves without error when tracing is disabled", async () => {
    delete process.env.LANGSMITH_TRACING;
    delete process.env.LANGSMITH_API_KEY;
    await expect(flushTraces()).resolves.toBeUndefined();
  });
});

describe("hashUserInput", () => {
  it("returns a 64-char hex SHA-256 digest", () => {
    const digest = hashUserInput("ignore previous instructions");
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for the same input", () => {
    expect(hashUserInput("payload")).toBe(hashUserInput("payload"));
  });

  it("produces different digests for different inputs", () => {
    expect(hashUserInput("a")).not.toBe(hashUserInput("b"));
  });
});

describe("getTracedAI when tracing IS enabled", () => {
  it("invokes wrapAISDK, attaches metadata, and resolves string models via gateway before delegating", async () => {
    vi.resetModules();
    process.env.LANGSMITH_TRACING = "true";
    process.env.LANGSMITH_API_KEY = "lsv2_test_key";

    const wrappedGenerateText = vi.fn().mockResolvedValue("gen-result");
    const wrappedStreamText = vi.fn().mockReturnValue("stream-result");
    const wrapAISDK = vi.fn().mockReturnValue({
      generateText: wrappedGenerateText,
      streamText: wrappedStreamText,
    });

    // Stub `gateway` so we can prove string models get resolved before being
    // handed to the LangSmith wrapper — that's the whole point of the bridge.
    const gatewayModel = { __gateway: true, modelId: "openai/gpt-5-nano" };
    const gateway = vi.fn().mockReturnValue(gatewayModel);

    vi.doMock("langsmith/experimental/vercel", () => ({ wrapAISDK }));
    vi.doMock("langsmith", () => ({
      Client: class {
        async awaitPendingTraceBatches() {
          return;
        }
      },
    }));
    vi.doMock("ai", async () => {
      const actual = await vi.importActual<typeof import("ai")>("ai");
      return { ...actual, gateway };
    });

    const mod = await import("./tracing");
    const traced = mod.getTracedAI();

    expect(wrapAISDK).toHaveBeenCalledTimes(1);
    expect(wrapAISDK.mock.calls[0][1].metadata).toEqual({
      app: "product-insights-agent",
    });

    // String model → gateway resolution → wrapped call gets the resolved object.
    await traced.generateText({ model: "openai/gpt-5-nano", prompt: "hi" });
    expect(gateway).toHaveBeenCalledWith("openai/gpt-5-nano");
    expect(wrappedGenerateText).toHaveBeenCalledWith({
      model: gatewayModel,
      prompt: "hi",
    });

    // Non-string models pass through untouched.
    const realModel = { modelId: "x", doGenerate: () => {} };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    traced.streamText({ model: realModel as any, prompt: "yo" });
    expect(wrappedStreamText).toHaveBeenCalledWith({
      model: realModel,
      prompt: "yo",
    });
    // gateway() should still only have been called once (for the string above).
    expect(gateway).toHaveBeenCalledTimes(1);
  });

  it("traceFunction wraps the fn when tracing is enabled and preserves behaviour", async () => {
    vi.resetModules();
    process.env.LANGSMITH_TRACING = "true";
    process.env.LANGSMITH_API_KEY = "lsv2_test_key";

    const traceable = vi.fn((fn: (x: number) => number) => {
      const wrapped = (x: number) => fn(x) + 100;
      // Tag so we can assert the wrapped fn is NOT the original reference.
      (wrapped as unknown as { __traced: boolean }).__traced = true;
      return wrapped;
    });

    vi.doMock("langsmith/traceable", () => ({ traceable }));
    vi.doMock("langsmith", () => ({
      Client: class {},
    }));

    const mod = await import("./tracing");
    const base = (x: number) => x * 2;
    const wrapped = mod.traceFunction(base, { name: "double" });
    expect(traceable).toHaveBeenCalledTimes(1);
    expect(wrapped).not.toBe(base);
    // Our fake traceable adds +100 on top of base's *2 — proves wrapping ran.
    expect(wrapped(5)).toBe(10 + 100);
  });
});
