import { NextResponse } from "next/server";
import { append, recent } from "@/server/events/buffer";
import type { WidgetEvent } from "@/widget-vanilla/events";
import { buildCorsHeaders } from "@/server/cors";
import { checkEmbedAuth } from "@/server/auth";

const CORS_METHODS = "GET, POST, OPTIONS";

export function OPTIONS(req: Request) {
  return new Response(null, {
    status: 204,
    headers: buildCorsHeaders(req, { methods: CORS_METHODS }),
  });
}

export async function POST(req: Request) {
  const corsHeaders = buildCorsHeaders(req, { methods: CORS_METHODS });

  const authFailure = checkEmbedAuth(req);
  if (authFailure) {
    return NextResponse.json(authFailure.body, {
      status: authFailure.status,
      headers: corsHeaders,
    });
  }

  let body: WidgetEvent;
  try {
    body = (await req.json()) as WidgetEvent;
  } catch {
    return NextResponse.json(
      { error: "invalid json" },
      { status: 400, headers: corsHeaders },
    );
  }
  if (
    !body ||
    typeof body.type !== "string" ||
    typeof body.sessionId !== "string" ||
    typeof body.productId !== "string"
  ) {
    return NextResponse.json(
      { error: "invalid event" },
      { status: 400, headers: corsHeaders },
    );
  }
  const stored = append(body);
  if (process.env.NODE_ENV === "development") {
    console.log("[event]", stored.type, {
      sessionId: stored.sessionId,
      productId: stored.productId,
      payload: (stored as { payload?: unknown }).payload,
    });
  }
  return NextResponse.json({ ok: true }, { headers: corsHeaders });
}

export async function GET(req: Request) {
  const corsHeaders = buildCorsHeaders(req, { methods: CORS_METHODS });
  const authFailure = checkEmbedAuth(req);
  if (authFailure) {
    return NextResponse.json(authFailure.body, {
      status: authFailure.status,
      headers: corsHeaders,
    });
  }
  return NextResponse.json({ events: recent() }, { headers: corsHeaders });
}
