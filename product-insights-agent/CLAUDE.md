# Product Insights Agent

A reference RAG architecture: an expert product sales assistant that answers customer questions about a product, grounded in the product's documentation via a vector store built with eval-driven chunking, contextual enrichment, and LLM-judged retrieval quality. Packaged as code + docs + demo + slides so teams can adopt it directly or use it as a blueprint.

## Domains

- **Ingestion pipeline** (`tooling/pipeline`, `tooling/evals`) — PDF → Markdown → token-aware chunking → contextual headers → OpenAI embeddings → MongoDB upsert. Eval-gated with a golden Q&A set, LLM-judge feedback loop, and grid sweep.
- **Vector retrieval** (`src/server/retrieval.ts`, `src/server/db`) — MongoDB Atlas Vector Search, cosine similarity, `productId` filter.
- **Chat API** (`app/api/chat`) — Next.js streaming route, parallel retrieval + classification, Vercel AI SDK, GPT-5-mini via AI Gateway.
- **Guardrails** (`src/server/guardrails`) — 4 layers mapped to OWASP LLM Top 10: input validation (regex, split into security + brand-voice patterns; fail-closed — detected injections return 400 before any LLM call) → in-context `<untrusted-input>` wrapping → LLM sensitive-topic routing (`gpt-5-nano` classifier, runs on every non-blocked request in parallel with retrieval) → output validation (regex, observability-only in this demo). See `docs/production-scaling/guardrails.md` for the production upgrades.
- **Widget** (`src/widget-vanilla`, `public/widget/host.html`, `public/embed.js`) — Vanilla TS widget bundled to `public/widget/widget.js`, embedded via `public/embed.js` as a sandboxed iframe pointing at `host.html`. The static `public/demo/` PDP is the example host.
- **Control panel** (`src/controlpanel`, `app/controlpanel`, dev-only) — Product selector, widget preview, quick tests, API/event inspection. Route 404s in production builds.
- **Prompt management** (`src/server/prompts`) — LangSmith Hub with hardcoded fallbacks; `:latest` → `:staging` → `:production` promotion.
- **Observability** (`src/server/observability`) — LangSmith tracing on the chat path; per-phase latency logging.
- **Docs** (`docs/`) — `concepts/` (RAG primers), `production-scaling/` (per-domain productionization notes).
