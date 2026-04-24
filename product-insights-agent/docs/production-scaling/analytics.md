# Analytics

The widget emits six typed events at real lifecycle points. This doc covers the gates between the demo pipeline and one a team can trust in production — adopter runs the agent for their own product, on their own infrastructure.

## What the demo emits

| Event | Emitted when | Payload |
| --- | --- | --- |
| `seed_questions_loaded` | Seed questions arrive (cache/fallback/fresh) | `{ count, source }` |
| `question_submitted` | User submits a question (seed pill, followup, or freeform) | `{ source, questionId? }` |
| `answer_started` | First token of the streamed answer arrives | `{}` |
| `answer_completed` | Stream terminates successfully | `{ durationMs, escalation }` |
| `answer_error` | Stream errors or never opens | `{ message }` |
| `disclaimer_opened` | User clicks the disclaimer link | `{}` |

Every event carries a widget-minted `sessionId`, an optional `clientId` forwarded from the storefront via `data-client-id`, a `productId`, a `type`, and a `ts`. The widget posts to `/api/events` fire-and-forget (`keepalive: true`) and never blocks UX on analytics. The server appends to an in-memory ring buffer, then fans out to every registered `EventSink`. The repo ships one stub sink (`AnalyticsSink`) — its `forward()` is a no-op by design. Adopters plug their own collector into the same interface.

## Priorities at a glance

| # | Problem | Priority |
|---|---|---|
| 1 | In-memory ring buffer evaporates on restart | P0 |
| 2 | Code-level cleanups before shipping | P0/P1 |
| 3 | `userId` must be resolved server-side, not trusted from the client | P1 |
| 4 | `clientId` PII policy is unstated | P1 |
| 5 | Real `EventSink` responsibilities (auth, retries, PII, schema, batching) | P1 |

Rate limiting on `/api/events` is a cross-cutting concern; canonical home is `embed-security.md`.

## In-memory ring buffer evaporates on restart (P0)

The buffer at `src/server/events/buffer.ts` is per-process. It doesn't survive restarts, doesn't span replicas, and can't be queried historically.

- Route events into whatever durable store the adopter's stack already uses (e.g. Redis pub/sub, a queue, a warehouse write).
- The SSE stream endpoint (`/api/events/stream`) is a dev-only affordance for the control panel; production builds should not expose it at all.

## Code-level cleanups before shipping (P0/P1)

Bundle of one-line config fixes that each shows up as an obvious gap on first production read:

- Gate `/api/events/stream` behind the same dev-only check the control panel uses; it currently ships in production builds.
- Restrict `Access-Control-Allow-Origin` on `/api/events` to known storefront origins; `*` lets any page POST spoofed events.
- Apply the adopter's existing rate-limit layer to `/api/events` — no backpressure today.
- Audit `keepalive: true` fetch budget (browsers cap at 64KB per origin); if vendor SDK calls are added inside `emit.ts`, fall back to `navigator.sendBeacon` for mission-critical events.

## `userId` must be resolved server-side (P1)

Never accept `userId` from the client. The auth cookie arrives on `/api/events`; resolve `userId` from it and attach before forwarding downstream. A forwarded client-supplied identity is trivially forgeable.

## `clientId` PII policy is unstated (P1)

`clientId` ends up in URL query strings (the iframe `src`), server logs, and referrer headers. It must be an opaque, non-PII identifier — e.g. a hash of GA4's `client_id` or Segment's `anonymousId`, never a raw email or account number. If widget events need to join to a specific user, do it server-side from the auth cookie, not via URL params.

## What a real `EventSink` must handle (P1)

The stub sink is demo code. A production `forward()` against any real collector owns:

- Credentials in server-side env vars, never in the widget bundle.
- PII scrubbing on fields that could identify a human (`clientId`, IP, over-specific user-agent).
- Schema mapping — the widget emits `{ type, sessionId, productId, payload, ts }`; most collectors expect `{ event, properties, anonymousId, timestamp }`.
- Retries with a dead-letter path; the fan-out is fire-and-forget, so at-least-once delivery is the sink's problem.
- Batching and backpressure — flush N events or M ms; never `await` anything that could hang the fan-out's caller.
