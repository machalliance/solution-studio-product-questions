"use client";

import type { EventEntry } from "./types";

interface Props {
  events: EventEntry[];
  onClear: () => void;
}

export function EventLog({ events, onClear }: Props) {
  return (
    <div className="mb-6 rounded-lg bg-white p-4 shadow-md">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-semibold text-zinc-900">Event Log</h2>
        <button
          type="button"
          onClick={onClear}
          className="text-xs text-zinc-500 hover:text-zinc-700"
        >
          Clear
        </button>
      </div>

      <p className="mb-2 text-[11px] text-zinc-400">
        Live feed of widget events from{" "}
        <code className="rounded bg-zinc-100 px-1">/api/events/stream</code>.
      </p>

      <div className="h-64 space-y-2 overflow-y-auto">
        {events.length === 0 ? (
          <p className="text-sm text-zinc-400">No events yet…</p>
        ) : (
          events.map((event, i) => (
            <div key={i} className="rounded bg-zinc-50 p-2 font-mono text-xs">
              <span className="text-zinc-400">{event.time}</span>{" "}
              <span className="font-semibold text-blue-600">{event.type}</span>
              {event.data !== undefined && (
                <pre className="mt-1 whitespace-pre-wrap text-zinc-600">
                  {JSON.stringify(event.data, null, 2)}
                </pre>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
