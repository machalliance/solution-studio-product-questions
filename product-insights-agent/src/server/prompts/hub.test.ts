import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  pullPrompt,
  applyTemplate,
  FALLBACK_PROMPTS,
  __clearPromptCache,
} from "./hub";

// Store original env
const originalEnv = { ...process.env };

// Mock langsmith Client
vi.mock("langsmith", () => ({
  Client: vi.fn().mockImplementation(() => ({
    pullPrompt: vi.fn(),
  })),
}));

beforeEach(() => {
  vi.clearAllMocks();
  __clearPromptCache();
  // Ensure tracing is disabled by default — forces fallback path
  delete process.env.LANGSMITH_TRACING;
  delete process.env.LANGSMITH_API_KEY;
  delete process.env.LANGSMITH_PROMPT_TAG;
  delete process.env.LANGSMITH_PROMPT_SOURCE;
  delete process.env.PROMPT_CACHE_TTL_MS;
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("FALLBACK_PROMPTS", () => {
  it("contains the assistant-system prompt", () => {
    const prompt = FALLBACK_PROMPTS["product-insights-agent-assistant-system"];
    expect(prompt).toBeDefined();
    expect(prompt.template).toContain("{productName}");
    expect(prompt.template).toContain("{productBrand}");
    expect(prompt.variables).toContain("productName");
    expect(prompt.variables).toContain("productBrand");
  });

  it("contains the escalation classifier prompt", () => {
    const prompt =
      FALLBACK_PROMPTS["product-insights-agent-escalation-classifier"];
    expect(prompt).toBeDefined();
    expect(prompt.template).toContain("content classifier");
    expect(prompt.variables).toEqual([]);
  });

  it("contains the seed question generator prompt", () => {
    const prompt =
      FALLBACK_PROMPTS["product-insights-agent-seed-question-generator"];
    expect(prompt).toBeDefined();
    expect(prompt.template).toContain("{count}");
    expect(prompt.variables).toContain("count");
  });
});

describe("pullPrompt", () => {
  it("returns fallback when LangSmith is not configured", async () => {
    const prompt = await pullPrompt("product-insights-agent-assistant-system");
    expect(prompt.template).toContain("{productName}");
    expect(prompt.variables).toContain("productName");
  });

  it("throws for unknown prompt when LangSmith is not configured", async () => {
    await expect(pullPrompt("nonexistent-prompt")).rejects.toThrow(
      'No fallback prompt found for "nonexistent-prompt"',
    );
  });

  it("returns fallback when LangSmith client throws", async () => {
    // Force the hub path — in non-production, pullPrompt defaults to local.
    process.env.LANGSMITH_PROMPT_SOURCE = "hub";
    process.env.LANGSMITH_TRACING = "true";
    process.env.LANGSMITH_API_KEY = "lsv2_test_key";

    // Mock Client to throw
    const { Client } = await import("langsmith");
    vi.mocked(Client).mockImplementation(
      () =>
        ({
          pullPromptCommit: vi
            .fn()
            .mockRejectedValue(new Error("Network error")),
        }) as never,
    );

    // Should fall back gracefully
    const prompt = await pullPrompt("product-insights-agent-assistant-system");
    expect(prompt.template).toContain("{productName}");
  });
});

describe("pullPrompt source resolution", () => {
  async function mockHub(template: string) {
    const { Client } = await import("langsmith");
    vi.mocked(Client).mockImplementation(function (this: unknown) {
      Object.assign(this as object, {
        pullPromptCommit: vi.fn().mockResolvedValue({ manifest: { template } }),
      });
    } as never);
  }

  it("uses the in-repo fallback in non-production even when tracing is configured", async () => {
    // vitest sets NODE_ENV=test; with no source override, pullPrompt should
    // bypass the hub entirely and return the in-repo template.
    process.env.LANGSMITH_TRACING = "true";
    process.env.LANGSMITH_API_KEY = "lsv2_test_key";
    await mockHub("hub-only template that must not be returned");

    const prompt = await pullPrompt("product-insights-agent-assistant-system");
    expect(prompt.template).toContain("{productName}");
    expect(prompt.template).not.toContain("hub-only template");
  });

  it("uses the hub in production when tracing is configured", async () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.LANGSMITH_TRACING = "true";
    process.env.LANGSMITH_API_KEY = "lsv2_test_key";
    process.env.PROMPT_CACHE_TTL_MS = "0";
    await mockHub("hub template wins in prod");

    const prompt = await pullPrompt("product-insights-agent-assistant-system");
    expect(prompt.template).toBe("hub template wins in prod");
    vi.unstubAllEnvs();
  });

  it("honors LANGSMITH_PROMPT_SOURCE=hub to force the hub path outside production", async () => {
    process.env.LANGSMITH_PROMPT_SOURCE = "hub";
    process.env.LANGSMITH_TRACING = "true";
    process.env.LANGSMITH_API_KEY = "lsv2_test_key";
    process.env.PROMPT_CACHE_TTL_MS = "0";
    await mockHub("forced hub template");

    const prompt = await pullPrompt("product-insights-agent-assistant-system");
    expect(prompt.template).toBe("forced hub template");
  });

  it("honors LANGSMITH_PROMPT_SOURCE=local to force the fallback path in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.LANGSMITH_PROMPT_SOURCE = "local";
    process.env.LANGSMITH_TRACING = "true";
    process.env.LANGSMITH_API_KEY = "lsv2_test_key";
    await mockHub("hub template that must not be returned");

    const prompt = await pullPrompt("product-insights-agent-assistant-system");
    expect(prompt.template).toContain("{productName}");
    vi.unstubAllEnvs();
  });
});

describe("applyTemplate", () => {
  it("substitutes variables in template", () => {
    const prompt = FALLBACK_PROMPTS["product-insights-agent-assistant-system"];
    const result = applyTemplate(prompt, {
      productName: "X40 Ultra",
      productBrand: "Dreame",
    });
    expect(result).toContain("X40 Ultra");
    expect(result).toContain("Dreame");
    expect(result).not.toContain("{productName}");
    expect(result).not.toContain("{productBrand}");
  });

  it("leaves unreplaced variables if not provided", () => {
    const prompt = FALLBACK_PROMPTS["product-insights-agent-assistant-system"];
    const result = applyTemplate(prompt, { productName: "X40 Ultra" });
    expect(result).toContain("X40 Ultra");
    expect(result).toContain("{productBrand}");
  });

  it("replaces every occurrence of a repeated variable", () => {
    const result = applyTemplate(
      {
        template: "{x} and {x} and {x}",
        variables: ["x"],
      },
      { x: "A" },
    );
    expect(result).toBe("A and A and A");
  });
});

describe("pullPrompt manifest parsing", () => {
  beforeEach(() => {
    // Force the hub path — pullPrompt defaults to the in-repo fallback
    // whenever NODE_ENV !== "production", which vitest always sets to "test".
    process.env.LANGSMITH_PROMPT_SOURCE = "hub";
    process.env.LANGSMITH_TRACING = "true";
    process.env.LANGSMITH_API_KEY = "lsv2_test_key";
  });

  async function mockClient(
    impl: () => { pullPromptCommit: (name: string) => Promise<unknown> },
  ) {
    const { Client } = await import("langsmith");
    // `Client` is used with `new`, so the mock must behave like a
    // constructor. Using function() {} lets vitest's auto-mock satisfy `new`.
    vi.mocked(Client).mockImplementation(function (this: unknown) {
      Object.assign(this as object, impl());
    } as never);
  }

  it("parses a promptMessages manifest with a SystemMessagePromptTemplate", async () => {
    await mockClient(() => ({
      pullPromptCommit: vi.fn().mockResolvedValue({
        manifest: {
          promptMessages: [
            {
              role: "SystemMessagePromptTemplate",
              prompt: {
                template: "You are a {role} for {brand}.",
              },
            },
          ],
        },
      }),
    }));

    const prompt = await pullPrompt("product-insights-agent-assistant-system");
    expect(prompt.template).toBe("You are a {role} for {brand}.");
    expect(prompt.variables).toEqual(expect.arrayContaining(["role", "brand"]));
  });

  it("parses a messages manifest with a system role message", async () => {
    await mockClient(() => ({
      pullPromptCommit: vi.fn().mockResolvedValue({
        manifest: {
          messages: [
            { role: "system", content: "Short system for {topic}." },
            { role: "user", content: "irrelevant" },
          ],
        },
      }),
    }));

    const prompt = await pullPrompt("product-insights-agent-assistant-system");
    expect(prompt.template).toBe("Short system for {topic}.");
    expect(prompt.variables).toEqual(["topic"]);
  });

  it("parses LangChain's serialized ChatPromptTemplate (kwargs-nested form)", async () => {
    // This is the exact shape LangSmith's hub returns for prompts pushed via
    // `ChatPromptTemplate.fromMessages([...])`. Regression test for a silent
    // fallback bug: the older parser only looked at `manifest.messages`, which
    // doesn't exist on this shape — so every hub edit was being ignored.
    await mockClient(() => ({
      pullPromptCommit: vi.fn().mockResolvedValue({
        manifest: {
          lc: 1,
          type: "constructor",
          id: ["langchain", "prompts", "chat", "ChatPromptTemplate"],
          kwargs: {
            input_variables: ["productName", "productBrand"],
            messages: [
              {
                lc: 1,
                type: "constructor",
                id: [
                  "langchain",
                  "prompts",
                  "chat",
                  "SystemMessagePromptTemplate",
                ],
                kwargs: {
                  prompt: {
                    lc: 1,
                    type: "constructor",
                    id: ["langchain", "prompts", "prompt", "PromptTemplate"],
                    kwargs: {
                      input_variables: ["productName", "productBrand"],
                      template_format: "f-string",
                      template:
                        "Hub-edited template for {productName} by {productBrand}.",
                    },
                  },
                },
              },
            ],
          },
        },
      }),
    }));

    const prompt = await pullPrompt("product-insights-agent-assistant-system");
    expect(prompt.template).toBe(
      "Hub-edited template for {productName} by {productBrand}.",
    );
    expect(prompt.variables).toEqual(
      expect.arrayContaining(["productName", "productBrand"]),
    );
  });

  it("parses a simple PromptTemplate manifest", async () => {
    await mockClient(() => ({
      pullPromptCommit: vi.fn().mockResolvedValue({
        manifest: { template: "Plain {count} template." },
      }),
    }));

    const prompt = await pullPrompt(
      "product-insights-agent-seed-question-generator",
    );
    expect(prompt.template).toBe("Plain {count} template.");
    expect(prompt.variables).toEqual(["count"]);
  });

  it("falls back when the manifest shape is unrecognized", async () => {
    await mockClient(() => ({
      pullPromptCommit: vi.fn().mockResolvedValue({
        manifest: { weird: "shape" },
      }),
    }));

    const prompt = await pullPrompt("product-insights-agent-assistant-system");
    // Falls back to the hardcoded default
    expect(prompt.template).toContain("{productName}");
  });

  it("falls back when the manifest is missing entirely", async () => {
    await mockClient(() => ({
      pullPromptCommit: vi.fn().mockResolvedValue({}),
    }));

    const prompt = await pullPrompt("product-insights-agent-assistant-system");
    expect(prompt.template).toContain("{productName}");
  });

  it("throws on a malformed manifest when no fallback is registered", async () => {
    await mockClient(() => ({
      pullPromptCommit: vi.fn().mockResolvedValue({
        manifest: { garbage: true },
      }),
    }));

    await expect(pullPrompt("prompt-with-no-fallback")).rejects.toThrow();
  });
});

describe("pullPrompt tag resolution", () => {
  beforeEach(() => {
    process.env.LANGSMITH_PROMPT_SOURCE = "hub";
    process.env.LANGSMITH_TRACING = "true";
    process.env.LANGSMITH_API_KEY = "lsv2_test_key";
    // Disable cache so each call hits the client and we can inspect args
    process.env.PROMPT_CACHE_TTL_MS = "0";
  });

  async function mockPullPromptCommit(spy: ReturnType<typeof vi.fn>) {
    const { Client } = await import("langsmith");
    vi.mocked(Client).mockImplementation(function (this: unknown) {
      Object.assign(this as object, { pullPromptCommit: spy });
    } as never);
  }

  it('defaults to the "latest" tag when no tag is configured', async () => {
    const spy = vi.fn().mockResolvedValue({
      manifest: { template: "hello" },
    });
    await mockPullPromptCommit(spy);

    await pullPrompt("product-insights-agent-assistant-system");

    expect(spy).toHaveBeenCalledWith(
      "product-insights-agent-assistant-system:latest",
    );
  });

  it("uses LANGSMITH_PROMPT_TAG when set", async () => {
    process.env.LANGSMITH_PROMPT_TAG = "production";
    const spy = vi.fn().mockResolvedValue({
      manifest: { template: "hello" },
    });
    await mockPullPromptCommit(spy);

    await pullPrompt("product-insights-agent-assistant-system");

    expect(spy).toHaveBeenCalledWith(
      "product-insights-agent-assistant-system:production",
    );
  });

  it("prefers an explicit options.tag over the env var", async () => {
    process.env.LANGSMITH_PROMPT_TAG = "production";
    const spy = vi.fn().mockResolvedValue({
      manifest: { template: "hello" },
    });
    await mockPullPromptCommit(spy);

    await pullPrompt("product-insights-agent-assistant-system", {
      tag: "staging",
    });

    expect(spy).toHaveBeenCalledWith(
      "product-insights-agent-assistant-system:staging",
    );
  });
});

describe("pullPrompt cache", () => {
  beforeEach(() => {
    process.env.LANGSMITH_PROMPT_SOURCE = "hub";
    process.env.LANGSMITH_TRACING = "true";
    process.env.LANGSMITH_API_KEY = "lsv2_test_key";
  });

  async function mockPullPromptCommit(spy: ReturnType<typeof vi.fn>) {
    const { Client } = await import("langsmith");
    vi.mocked(Client).mockImplementation(function (this: unknown) {
      Object.assign(this as object, { pullPromptCommit: spy });
    } as never);
  }

  it("hits the hub only once within the TTL window", async () => {
    process.env.PROMPT_CACHE_TTL_MS = "60000";
    const spy = vi.fn().mockResolvedValue({
      manifest: { template: "cached template" },
    });
    await mockPullPromptCommit(spy);

    const a = await pullPrompt("product-insights-agent-assistant-system");
    const b = await pullPrompt("product-insights-agent-assistant-system");
    const c = await pullPrompt("product-insights-agent-assistant-system");

    expect(spy).toHaveBeenCalledTimes(1);
    expect(a.template).toBe("cached template");
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it("caches separately per tag", async () => {
    process.env.PROMPT_CACHE_TTL_MS = "60000";
    const spy = vi.fn().mockImplementation((identifier: string) =>
      Promise.resolve({
        manifest: { template: `template for ${identifier}` },
      }),
    );
    await mockPullPromptCommit(spy);

    const prod = await pullPrompt("product-insights-agent-assistant-system", {
      tag: "production",
    });
    const staging = await pullPrompt(
      "product-insights-agent-assistant-system",
      {
        tag: "staging",
      },
    );
    const prodAgain = await pullPrompt(
      "product-insights-agent-assistant-system",
      {
        tag: "production",
      },
    );

    expect(spy).toHaveBeenCalledTimes(2);
    expect(prod.template).toContain("production");
    expect(staging.template).toContain("staging");
    expect(prodAgain).toBe(prod);
  });

  it("serves stale while revalidating after the TTL expires", async () => {
    process.env.PROMPT_CACHE_TTL_MS = "10";

    let callCount = 0;
    const spy = vi.fn().mockImplementation(() => {
      callCount += 1;
      return Promise.resolve({
        manifest: { template: `v${callCount}` },
      });
    });
    await mockPullPromptCommit(spy);

    const first = await pullPrompt("product-insights-agent-assistant-system");
    expect(first.template).toBe("v1");

    // Wait past TTL
    await new Promise((r) => setTimeout(r, 25));

    // Second call returns the STALE value immediately; refresh fires in background
    const second = await pullPrompt("product-insights-agent-assistant-system");
    expect(second.template).toBe("v1");

    // Give the background refresh a tick to complete
    await new Promise((r) => setTimeout(r, 25));

    // Now a third call returns the refreshed value. (With a 10ms TTL this
    // call may itself trigger another background refresh — we only care that
    // the cached value has been updated to v2 or newer.)
    const third = await pullPrompt("product-insights-agent-assistant-system");
    expect(["v2", "v3"]).toContain(third.template);
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps serving the stale cached value when the background refresh throws", async () => {
    process.env.PROMPT_CACHE_TTL_MS = "10";

    let callCount = 0;
    const spy = vi.fn().mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) {
        return Promise.resolve({ manifest: { template: "v1" } });
      }
      return Promise.reject(new Error("hub is down"));
    });
    await mockPullPromptCommit(spy);

    const first = await pullPrompt("product-insights-agent-assistant-system");
    expect(first.template).toBe("v1");

    await new Promise((r) => setTimeout(r, 25));

    // Stale cache served while background refresh is inflight
    const second = await pullPrompt("product-insights-agent-assistant-system");
    expect(second.template).toBe("v1");

    // Let the background refresh fail
    await new Promise((r) => setTimeout(r, 25));

    // Still serving the stale cached value despite the failure
    const third = await pullPrompt("product-insights-agent-assistant-system");
    expect(third.template).toBe("v1");
  });

  it("skips caching when PROMPT_CACHE_TTL_MS=0", async () => {
    process.env.PROMPT_CACHE_TTL_MS = "0";
    const spy = vi.fn().mockResolvedValue({
      manifest: { template: "hello" },
    });
    await mockPullPromptCommit(spy);

    await pullPrompt("product-insights-agent-assistant-system");
    await pullPrompt("product-insights-agent-assistant-system");
    await pullPrompt("product-insights-agent-assistant-system");

    expect(spy).toHaveBeenCalledTimes(3);
  });
});
