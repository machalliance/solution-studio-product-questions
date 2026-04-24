import { recent, type StoredEvent } from "@/server/events/buffer";
import { registerSink, type EventSink } from "@/server/events/sinks";

export const dynamic = "force-dynamic";

let connectionSeq = 0;

export async function GET(req: Request) {
  const encoder = new TextEncoder();
  let unregister: (() => void) | null = null;
  let hb: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const send = (data: unknown) => {
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          // controller closed
        }
      };

      for (const e of recent()) send(e);

      const sink: EventSink = {
        name: `sse-${++connectionSeq}`,
        forward(event: StoredEvent) {
          send(event);
        },
      };
      unregister = registerSink(sink);

      hb = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": hb\n\n"));
        } catch {
          // controller closed
        }
      }, 15000);

      req.signal.addEventListener("abort", () => {
        if (hb) clearInterval(hb);
        if (unregister) unregister();
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
    },
    cancel() {
      if (hb) clearInterval(hb);
      if (unregister) unregister();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
