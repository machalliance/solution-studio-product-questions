import type { WidgetEvent } from "./events";

export function createEmitter(opts: {
  apiBase: string;
  sessionId: string;
  clientId?: string;
  productId: string;
  secret?: string;
}) {
  return function emit<T extends WidgetEvent["type"]>(
    type: T,
    payload: Extract<WidgetEvent, { type: T }>["payload"],
  ): void {
    const event = {
      sessionId: opts.sessionId,
      clientId: opts.clientId,
      productId: opts.productId,
      type,
      ts: Date.now(),
      payload,
    };
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (opts.secret) headers["Authorization"] = `Bearer ${opts.secret}`;
      fetch(`${opts.apiBase}/api/events`, {
        method: "POST",
        headers,
        body: JSON.stringify(event),
        keepalive: true,
      }).catch(() => {});
    } catch {
      // never throw from emit
    }
  };
}

export type WidgetEmitter = ReturnType<typeof createEmitter>;
