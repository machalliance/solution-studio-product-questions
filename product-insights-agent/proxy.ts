import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

function constantTimeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

/**
 * Gates static widget host assets behind the embed secret so that
 * `widget/host.html` cannot be loaded by unauthorized embedders. The secret
 * is supplied by the storefront as `?secret=...` — see public/embed.js.
 *
 * Production with missing env → 503 (fail closed).
 * Development with missing env → passthrough (ergonomic for local dev).
 */
export function proxy(req: NextRequest) {
  const configured = process.env.WIDGET_EMBED_SECRET;
  if (!configured || !configured.trim()) {
    if (process.env.NODE_ENV === "production") {
      return new NextResponse("Widget embed secret is not configured.", {
        status: 503,
      });
    }
    return NextResponse.next();
  }

  const presented = req.nextUrl.searchParams.get("secret");
  if (!presented || !constantTimeEqual(presented, configured)) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/widget/host.html"],
};
