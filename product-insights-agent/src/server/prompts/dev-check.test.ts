import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const originalEnv = { ...process.env };

// Build a mock Client so we can control what pullPromptCommit returns per prompt.
const pullPromptCommitMock = vi.fn();

vi.mock("langsmith", () => ({
  Client: vi.fn().mockImplementation(function (this: unknown) {
    Object.assign(this as object, {
      pullPromptCommit: pullPromptCommitMock,
    });
  }),
}));

// Minimal fallback set — we import the module-under-test AFTER setting this
// up, and the module itself imports FALLBACK_PROMPTS from ./hub. We mock the
// whole module so the test is hermetic.
vi.mock("./hub", async () => {
  const actual = await vi.importActual<typeof import("./hub")>("./hub");
  return {
    ...actual,
    FALLBACK_PROMPTS: {
      "product-insights-agent-assistant-system": {
        template: "SYSTEM TEMPLATE V1",
        variables: [],
      },
      "product-insights-agent-escalation-classifier": {
        template: "CLASSIFIER TEMPLATE V1",
        variables: [],
      },
    },
  };
});

import { runPromptSyncCheck } from "./dev-check";

beforeEach(() => {
  vi.clearAllMocks();
  (process.env as Record<string, string>).NODE_ENV = "development";
  process.env.LANGSMITH_API_KEY = "lsv2_test_key";
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("runPromptSyncCheck", () => {
  it("logs in-sync when hub and fallback match exactly", async () => {
    // Return the hub template that matches each prompt's fallback
    pullPromptCommitMock.mockImplementation(async (identifier: string) => {
      if (identifier.startsWith("product-insights-agent-assistant-system")) {
        return {
          manifest: {
            messages: [{ role: "system", content: "SYSTEM TEMPLATE V1" }],
          },
        };
      }
      return {
        manifest: {
          messages: [{ role: "system", content: "CLASSIFIER TEMPLATE V1" }],
        },
      };
    });

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await runPromptSyncCheck();

    // One summary line + one in-sync line per prompt
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("in sync with hub"),
    );
    expect(warn).not.toHaveBeenCalled();

    log.mockRestore();
    warn.mockRestore();
  });

  it("logs drifted when the hub template differs from the fallback", async () => {
    pullPromptCommitMock.mockResolvedValue({
      manifest: {
        messages: [{ role: "system", content: "HUB HAS EDITED THIS" }],
      },
    });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    await runPromptSyncCheck();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("drifted"));

    warn.mockRestore();
  });

  it("logs missing-in-hub when pullPromptCommit throws not-found", async () => {
    pullPromptCommitMock.mockRejectedValue(new Error("404 not found"));

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    await runPromptSyncCheck();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("not found in hub"),
    );

    warn.mockRestore();
  });

  it("logs hub-unreachable on non-404 errors", async () => {
    pullPromptCommitMock.mockRejectedValue(new Error("ECONNREFUSED"));

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    await runPromptSyncCheck();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("could not reach LangSmith"),
    );

    warn.mockRestore();
  });

  it("no-ops in production", async () => {
    (process.env as Record<string, string>).NODE_ENV = "production";

    await runPromptSyncCheck();

    expect(pullPromptCommitMock).not.toHaveBeenCalled();
  });

  it("no-ops when LANGSMITH_API_KEY is unset", async () => {
    delete process.env.LANGSMITH_API_KEY;

    await runPromptSyncCheck();

    expect(pullPromptCommitMock).not.toHaveBeenCalled();
  });

  it("pulls the :latest tag, not :production", async () => {
    pullPromptCommitMock.mockResolvedValue({
      manifest: {
        messages: [{ role: "system", content: "SYSTEM TEMPLATE V1" }],
      },
    });
    vi.spyOn(console, "log").mockImplementation(() => {});

    await runPromptSyncCheck();

    for (const call of pullPromptCommitMock.mock.calls) {
      expect(call[0]).toMatch(/:latest$/);
    }
  });
});
