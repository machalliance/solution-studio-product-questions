import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { checkEmbedAuth } from "./auth";

const SECRET = "s3cret-token-value-xyz";

function reqWith(headers: Record<string, string>): Request {
  return new Request("https://example.com/api/chat", {
    method: "POST",
    headers,
  });
}

describe("checkEmbedAuth", () => {
  beforeEach(() => {
    vi.stubEnv("WIDGET_EMBED_SECRET", "");
    vi.stubEnv("NODE_ENV", "test");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("passes through when secret is unset in development", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(checkEmbedAuth(reqWith({}))).toBeNull();
  });

  it("fails closed with 503 when secret is unset in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    const failure = checkEmbedAuth(reqWith({}));
    expect(failure?.status).toBe(503);
  });

  it("returns 401 when secret is configured but header is missing", () => {
    vi.stubEnv("WIDGET_EMBED_SECRET", SECRET);
    const failure = checkEmbedAuth(reqWith({}));
    expect(failure?.status).toBe(401);
  });

  it("returns 401 when bearer token does not match", () => {
    vi.stubEnv("WIDGET_EMBED_SECRET", SECRET);
    const failure = checkEmbedAuth(
      reqWith({ authorization: "Bearer wrong-token-wrong-token-wrong-t" }),
    );
    expect(failure?.status).toBe(401);
  });

  it("returns 401 when bearer token length differs (constant-time guard)", () => {
    vi.stubEnv("WIDGET_EMBED_SECRET", SECRET);
    const failure = checkEmbedAuth(reqWith({ authorization: "Bearer short" }));
    expect(failure?.status).toBe(401);
  });

  it("returns 401 for non-Bearer scheme", () => {
    vi.stubEnv("WIDGET_EMBED_SECRET", SECRET);
    const failure = checkEmbedAuth(
      reqWith({ authorization: `Basic ${SECRET}` }),
    );
    expect(failure?.status).toBe(401);
  });

  it("passes when bearer token matches the configured secret", () => {
    vi.stubEnv("WIDGET_EMBED_SECRET", SECRET);
    expect(
      checkEmbedAuth(reqWith({ authorization: `Bearer ${SECRET}` })),
    ).toBeNull();
  });

  it("accepts case-insensitive Bearer scheme per RFC 6750", () => {
    vi.stubEnv("WIDGET_EMBED_SECRET", SECRET);
    expect(
      checkEmbedAuth(reqWith({ authorization: `bearer ${SECRET}` })),
    ).toBeNull();
  });

  it("treats an empty-string secret env as unset", () => {
    vi.stubEnv("WIDGET_EMBED_SECRET", "   ");
    vi.stubEnv("NODE_ENV", "development");
    expect(checkEmbedAuth(reqWith({}))).toBeNull();
  });
});
