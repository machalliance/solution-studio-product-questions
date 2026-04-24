import type { StoredEvent } from "./buffer";

export interface EventSink {
  name: string;
  forward(event: StoredEvent): Promise<void> | void;
}

const sinks = new Set<EventSink>();

export function registerSink(sink: EventSink): () => void {
  sinks.add(sink);
  return () => {
    sinks.delete(sink);
  };
}

export function fanout(event: StoredEvent): void {
  for (const sink of sinks) {
    try {
      const result = sink.forward(event);
      if (result && typeof (result as Promise<void>).catch === "function") {
        (result as Promise<void>).catch((err) => {
          console.warn(`[event-sink:${sink.name}] forward failed:`, err);
        });
      }
    } catch (err) {
      console.warn(`[event-sink:${sink.name}] forward threw:`, err);
    }
  }
}

export function registeredSinkNames(): string[] {
  return Array.from(sinks, (s) => s.name);
}
