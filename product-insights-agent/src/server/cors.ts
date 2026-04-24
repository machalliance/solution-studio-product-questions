let devWarned = false;

function parseAllowlist(): string[] {
  const raw = process.env.WIDGET_ALLOWED_ORIGINS;
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function isProd(): boolean {
  return process.env.NODE_ENV === "production";
}

function pickAllowedOrigin(
  requestOrigin: string | null,
  allowlist: string[],
): string | null {
  if (!requestOrigin) return null;
  if (allowlist.includes(requestOrigin)) return requestOrigin;
  return null;
}

export interface CorsOptions {
  methods: string;
}

/**
 * Builds CORS headers for a response, honoring the WIDGET_ALLOWED_ORIGINS
 * env var.
 *
 * - Allowlist configured: echo back the request's Origin iff it's in the list.
 *   Mismatch → omit `Access-Control-Allow-Origin` entirely so the browser
 *   blocks the response.
 * - Allowlist empty and NODE_ENV !== production: permissive `*` with a
 *   one-time warning, so local dev and preview URLs still work.
 * - Allowlist empty in production: no ACAO header → no cross-origin access.
 *
 * Always sets Vary: Origin so CDN caches don't poison responses across
 * origins.
 */
export function buildCorsHeaders(
  req: Request,
  opts: CorsOptions,
): Record<string, string> {
  const allowlist = parseAllowlist();
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": opts.methods,
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    Vary: "Origin",
  };

  if (allowlist.length === 0) {
    if (!isProd()) {
      if (!devWarned) {
        devWarned = true;
        console.warn(
          "[cors] WIDGET_ALLOWED_ORIGINS is unset — falling back to '*' for development. Set it in production.",
        );
      }
      headers["Access-Control-Allow-Origin"] = "*";
    }
    return headers;
  }

  const requestOrigin = req.headers.get("origin");
  const allowed = pickAllowedOrigin(requestOrigin, allowlist);
  if (allowed) {
    headers["Access-Control-Allow-Origin"] = allowed;
  }
  return headers;
}
