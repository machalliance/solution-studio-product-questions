# Observability

The demo instruments only the runtime chat path: widget → guardrails → retrieval → classification → streamed answer. Ingestion, offline evals, and seed-question generation run untraced. That scope is intentional for a reference demo; a team adopting this for their own product will need to broaden it. This doc covers the gaps.

## What the demo traces today

LangSmith tracing activates when `LANGSMITH_TRACING=true` and `LANGSMITH_API_KEY` is set. One trace is emitted per `/api/chat` request, containing the pre-stream pipeline span (with guardrail trigger, classifier output, retrieved chunk IDs and scores attached as metadata), the `streamText` call as a child LLM span, and the `gpt-5-nano` classifier as a child LLM span on every non-blocked request.

Raw `userQuestion` is only attached to the span after the deterministic pattern guard clears the request. Blocked requests carry `user_question_length` + `user_question_sha256` plus the guardrail trigger fields, and `traceFunction` is configured without argument capture — so detected injection payloads never land in a sink that an LLM-based summarizer might re-read.

## Priorities at a glance

| #   | Problem                                                                   | Priority |
| --- | ------------------------------------------------------------------------- | -------- |
| 1   | No alerting on grounding, escalation, latency, tokens, guardrail rate     | P0       |
| 2   | Eval artifacts on local disk, not shared across the team                  | P1       |
| 3   | Tracing stops at the chat path (ingestion, embeddings, seed-gen untraced) | P1       |
| 4   | Operational hygiene (best-effort, skip deterministic CPU work)            | P2       |

## No alerting on chat-path signals (P0)

Traces exist; alerts on them don't. Once they're wired, the signals worth paging on:

- Grounding / faithfulness trend (drops indicate retrieval degradation or prompt drift).
- Escalation rate (spikes = classifier false positives; drops = missed sensitive topics).
- p95 latency per phase so a regression in one doesn't hide behind the others.
- Token usage per request (unexpected growth signals prompt bloat or retrieval bringing back too many chunks).
- Guardrail trigger rate (spikes can be a new attack pattern or a legitimate-query regression).

## Eval artifacts on local disk (P1)

The demo writes golden Q&A sets and eval reports to `data/eval-sets/` and `data/eval-reports/`. That's single-operator scope.

- Golden datasets should live in a managed evaluation platform (e.g. LangSmith datasets, Langfuse, Arize Phoenix) so the team evaluates against the same versioned inputs.
- Eval runs should be experiments tagged with pipeline config (chunk size, overlap, models, git SHA) so regressions are detectable across runs, not by diffing JSON.
- Local `data/eval-*` artifacts stay useful for CI and offline debugging; the managed platform is additive.

## Tracing coverage stops at the chat path (P1)

Everything outside `/api/chat` is invisible. In order of value:

- Embedding calls on the chat path — the query embedding for retrieval isn't traced, and embeddings are the highest-volume LLM call in RAG.
- Ingestion pipeline — extraction, contextualization, chunking decisions, embedding generation should emit traces so quality and cost are visible over time, not only at demo time.
- Seed-question generation — candidate generation and answerability validation should be traced so regressions (after a manual update or model swap) are catchable.

## Operational hygiene (P2)

- Tracing must be best-effort. The runtime must not depend on the observability backend being available. The demo's `isTracingEnabled()` gate enforces this on the chat path; keep the contract as coverage grows.
- Don't trace deterministic CPU work. Chunking, metadata enrichment, and similar high-volume deterministic steps add noise and ingest cost without signal; their outputs belong in the eval dataset, not the trace stream.
