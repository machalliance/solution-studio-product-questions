import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildCorsHeaders } from "./cors";

function reqFrom(origin: string | null): Request {
  const headers: Record<string, string> = {};
  if (origin) headers.origin = origin;
  return new Request("https://widget.example.com/api/chat", {
    method: "POST",
    headers,
  });
}

describe("buildCorsHeaders", () => {
  beforeEach(() => {
    vi.stubEnv("WIDGET_ALLOWED_ORIGINS", "");
    vi.stubEnv("NODE_ENV", "test");
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("echoes an allowed origin back to the client", () => {
    vi.stubEnv(
      "WIDGET_ALLOWED_ORIGINS",
      "https://storefront.example.com,https://other.example.com",
    );
    const headers = buildCorsHeaders(
      reqFrom("https://storefront.example.com"),
      { methods: "POST, OPTIONS" },
    );
    expect(headers["Access-Control-Allow-Origin"]).toBe(
      "https://storefront.example.com",
    );
  });

  it("omits Access-Control-Allow-Origin for an origin not in the allowlist", () => {
    vi.stubEnv("WIDGET_ALLOWED_ORIGINS", "https://storefront.example.com");
    const headers = buildCorsHeaders(reqFrom("https://evil.example.com"), {
      methods: "POST, OPTIONS",
    });
    expect(headers["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  it("omits Access-Control-Allow-Origin when there's no Origin header and allowlist is configured", () => {
    vi.stubEnv("WIDGET_ALLOWED_ORIGINS", "https://storefront.example.com");
    const headers = buildCorsHeaders(reqFrom(null), {
      methods: "POST, OPTIONS",
    });
    expect(headers["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  it("falls back to * with a warning when allowlist is unset in dev", () => {
    vi.stubEnv("NODE_ENV", "development");
    const headers = buildCorsHeaders(reqFrom("https://anything.example.com"), {
      methods: "POST, OPTIONS",
    });
    expect(headers["Access-Control-Allow-Origin"]).toBe("*");
  });

  it("omits Access-Control-Allow-Origin when allowlist is unset in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    const headers = buildCorsHeaders(reqFrom("https://anything.example.com"), {
      methods: "POST, OPTIONS",
    });
    expect(headers["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  it("always sets Vary: Origin to prevent cache poisoning", () => {
    vi.stubEnv("WIDGET_ALLOWED_ORIGINS", "https://storefront.example.com");
    const headers = buildCorsHeaders(
      reqFrom("https://storefront.example.com"),
      { methods: "POST, OPTIONS" },
    );
    expect(headers["Vary"]).toBe("Origin");
  });

  it("advertises the requested methods", () => {
    const headers = buildCorsHeaders(reqFrom("https://anything.example.com"), {
      methods: "GET, OPTIONS",
    });
    expect(headers["Access-Control-Allow-Methods"]).toBe("GET, OPTIONS");
  });

  it("advertises Authorization in allowed headers", () => {
    const headers = buildCorsHeaders(reqFrom("https://anything.example.com"), {
      methods: "POST, OPTIONS",
    });
    expect(headers["Access-Control-Allow-Headers"]).toContain("Authorization");
  });

  it("trims whitespace from allowlist entries", () => {
    vi.stubEnv(
      "WIDGET_ALLOWED_ORIGINS",
      "  https://a.example.com , https://b.example.com  ",
    );
    const headers = buildCorsHeaders(reqFrom("https://b.example.com"), {
      methods: "POST, OPTIONS",
    });
    expect(headers["Access-Control-Allow-Origin"]).toBe(
      "https://b.example.com",
    );
  });
});
