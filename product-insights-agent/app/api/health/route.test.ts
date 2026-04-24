import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCheckConnection = vi.fn();

vi.mock("@/server/db/client", () => ({
  checkConnection: (...args: unknown[]) => mockCheckConnection(...args),
}));

import { GET } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/health", () => {
  it("returns 200 with status=healthy when the database is reachable", async () => {
    mockCheckConnection.mockResolvedValueOnce({ connected: true });

    const res = await GET();
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe("healthy");
    expect(body.services.app.status).toBe("up");
    expect(body.services.database.status).toBe("up");
    expect(body.services.database.error).toBeUndefined();
    expect(typeof body.timestamp).toBe("string");
  });

  it("returns 503 with status=degraded and propagates the db error when the database is down", async () => {
    mockCheckConnection.mockResolvedValueOnce({
      connected: false,
      error: "ECONNREFUSED mongodb://localhost:27017",
    });

    const res = await GET();
    expect(res.status).toBe(503);

    const body = await res.json();
    expect(body.status).toBe("degraded");
    expect(body.services.app.status).toBe("up");
    expect(body.services.database.status).toBe("down");
    expect(body.services.database.error).toContain("ECONNREFUSED");
  });

  it("omits the error field when the db reports disconnected without a message", async () => {
    mockCheckConnection.mockResolvedValueOnce({ connected: false });

    const res = await GET();
    expect(res.status).toBe(503);

    const body = await res.json();
    expect(body.services.database.status).toBe("down");
    expect(body.services.database.error).toBeUndefined();
  });
});
