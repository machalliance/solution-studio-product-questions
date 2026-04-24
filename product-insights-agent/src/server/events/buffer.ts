import type { WidgetEvent } from "@/widget-vanilla/events";
import { fanout } from "./sinks";

export type StoredEvent = WidgetEvent & { receivedAt: number };

const MAX = 200;
const buffer: StoredEvent[] = [];

export function append(event: WidgetEvent): StoredEvent {
  const stored = { ...event, receivedAt: Date.now() } as StoredEvent;
  buffer.push(stored);
  if (buffer.length > MAX) buffer.shift();
  fanout(stored);
  return stored;
}

export function recent(limit = 50): StoredEvent[] {
  return buffer.slice(-limit);
}
