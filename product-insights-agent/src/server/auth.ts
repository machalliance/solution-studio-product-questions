import { timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";

const BEARER = /^Bearer\s+(.+)$/i;

function getConfiguredSecret(): string | null {
  const secret = process.env.WIDGET_EMBED_SECRET;
  if (!secret || !secret.trim()) return null;
  return secret;
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function extractBearer(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const match = BEARER.exec(header);
  return match ? match[1].trim() : null;
}

export interface EmbedAuthFailure {
  status: 401 | 503;
  body: { error: string };
}

/**
 * Validates the widget embed secret against the Authorization: Bearer header.
 *
 * - Production: missing env → 503 (fail closed).
 * - Development: missing env → pass through (ergonomic for local dev).
 * - Token mismatch / missing header → 401 in all environments.
 *
 * Returns `null` on success so callers can `if (fail) return fail`.
 */
export function checkEmbedAuth(req: Request): EmbedAuthFailure | null {
  const configured = getConfiguredSecret();
  if (!configured) {
    if (process.env.NODE_ENV === "production") {
      return {
        status: 503,
        body: { error: "Widget embed secret is not configured." },
      };
    }
    return null;
  }
  const presented = extractBearer(req);
  if (!presented || !constantTimeEqual(presented, configured)) {
    return { status: 401, body: { error: "Unauthorized" } };
  }
  return null;
}

/**
 * Convenience: returns a NextResponse for an auth failure, or `null` if the
 * request is authorized. Use in route handlers where CORS headers should be
 * attached to the error response too.
 */
export function buildAuthFailureResponse(
  failure: EmbedAuthFailure,
  headers: HeadersInit,
): NextResponse {
  return NextResponse.json(failure.body, {
    status: failure.status,
    headers,
  });
}
