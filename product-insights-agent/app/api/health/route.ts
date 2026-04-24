import { NextResponse } from "next/server";
import { checkConnection } from "@/server/db/client";

export async function GET() {
  const dbStatus = await checkConnection();

  const status = {
    status: dbStatus.connected ? "healthy" : "degraded",
    timestamp: new Date().toISOString(),
    services: {
      app: { status: "up" },
      database: {
        status: dbStatus.connected ? "up" : "down",
        ...(dbStatus.error && { error: dbStatus.error }),
      },
    },
  };

  return NextResponse.json(status, {
    status: dbStatus.connected ? 200 : 503,
  });
}
