"use client";

import { useEffect, useState } from "react";
import { ProductSelector } from "./ProductSelector";
import { WidgetPreview } from "./WidgetPreview";
import { EventLog } from "./EventLog";
import { ApiEndpoints } from "./ApiEndpoints";
import { QuickTests } from "./QuickTests";
import type { EventEntry } from "./types";

const MAX_EVENTS = 20;

export function ControlPanelPage() {
  const [productId, setProductId] = useState("dreame-x40-ultra");
  const [events, setEvents] = useState<EventEntry[]>([]);

  useEffect(() => {
    const es = new EventSource("/api/events/stream");
    es.onmessage = (msg) => {
      try {
        const parsed = JSON.parse(msg.data);
        const timeSource = parsed.receivedAt ?? parsed.ts ?? Date.now();
        setEvents((prev) => [
          {
            type: parsed.type,
            data: parsed,
            time: new Date(timeSource).toLocaleTimeString(),
          },
          ...prev.slice(0, MAX_EVENTS - 1),
        ]);
      } catch {
        // ignore malformed frames
      }
    };
    es.onerror = () => {
      // EventSource auto-reconnects; nothing to do.
    };
    return () => es.close();
  }, []);

  return (
    <div className="min-h-screen bg-zinc-100">
      <main className="mx-auto max-w-6xl px-4 py-8">
        <h1 className="mb-2 text-3xl font-bold text-zinc-900">
          Product Insights Widget — Control Panel
        </h1>
        <p className="mb-8 text-zinc-600">
          Development &amp; Testing Interface (dev builds only)
        </p>

        <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
          <div>
            <ProductSelector
              productId={productId}
              onProductIdChange={setProductId}
            />
            <WidgetPreview productId={productId} />
          </div>

          <div>
            <EventLog events={events} onClear={() => setEvents([])} />
            <ApiEndpoints />
            <QuickTests productId={productId} />
          </div>
        </div>
      </main>
    </div>
  );
}
