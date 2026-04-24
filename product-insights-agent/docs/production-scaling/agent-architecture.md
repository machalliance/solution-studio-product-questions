# Agent architecture

The demo is a **single-shot RAG pipeline**: the user's question is embedded as-is, retrieved once from MongoDB Atlas Vector Search, and passed to `gpt-5-mini` in a single streaming call. No query rewriting, no router, no iterative retrieval. See the [README — How the agent answers a question](../../README.md#how-the-agent-answers-a-question) for the current flow.

Escalation classification (`gpt-5-nano`, `reasoningEffort: "minimal"`) runs in parallel with retrieval to decide whether a question is answerable or routed to a human. It picks between "answer" and "escalate" — not between retrieval strategies. There is no query rewriter, second vector search, reranker, tool-calling loop, or follow-up retrieval.

This doc is deliberately a design-decision doc, not a problem list: the constraint on a real-time PDP widget is TTFT, and the recommendation is to stay single-shot by default.

## Recommendation

1. **Keep single-shot as the happy path.** The eval sweep already shows a ~92% pass rate on golden questions. Don't trade measured UX for hypothetical quality gains.
2. **If you need a router, start with classification, not tool use.** A small classifier in parallel with retrieval (the pattern escalation already uses) gives dispatch without adding an LLM turn to the critical path.
3. **Reserve agentic search for multi-hop / cross-section questions, identified via evals.** Build the golden set for that class first, then decide whether the TTFT cost is acceptable.
4. **Keep guardrails outside any agent loop.** Pattern guard runs before any LLM call; `<untrusted-input>` wrapping is applied at prompt construction; the post-response check runs on the final stream. Moving them inside an agent loop turns deterministic guarantees into probabilistic ones.
5. **Hard-cap iterations and tokens per request.** E.g. 2 retrieval calls max, a fixed total prompt token budget, a wall-clock timeout. Fail closed (fall back to single-shot) on cap breach.

## Three patterns, ranked by when to adopt

### Router (classify → dispatch) — P1 when >1 backing data source

A small LLM looks at the question and chooses `answer_from_vector_store` / `answer_from_structured_catalog` (direct PIM / commercetools lookup) / `escalate_to_human` / `out_of_scope`.

- **When to adopt.** More than one backing data source (structured catalog for price / stock, vector store for long-form content), or when escalation categories outgrow a single classifier prompt.
- **Cost.** One extra LLM call per request, additive to TTFT on the happy path — unless run in parallel with retrieval and the losers cancelled.

### Agentic on retry — P2

Always try single-shot first. If the post-check or an online grounding evaluator flags the answer as low-confidence, fall back to an agentic retry in the background and replace the answer. Happy-path TTFT stays unchanged; the agent cost is paid only on the ~5–10% of questions that need it. Plays well with the existing escalation-header pattern — add an `x-low-confidence: true` header and show a "refining answer…" state while the retry runs.

### Full agentic search — P3

The LLM decomposes the question, fans out parallel retrieval calls, then follows up based on what came back.

- **When to adopt.** When eval data shows a meaningful class of questions (>10% of real traffic) where single-shot retrieval is demonstrably insufficient — not from intuition.
- **Cost.** Latency is multiplicative per iteration (streaming hides some of it, but time-to-_first_-token balloons). Token cost is multiplicative too (each iteration re-sends system prompt + chunks). Failure modes expand — loops on bad retrievals, over-fan-out on simple questions — requiring iteration caps, token budgets, per-call timeouts, and evals for "did the agent terminate correctly." Determinism drops, so eval interpretation gets harder.

UX is the hard constraint. Shoppers will not wait seconds for an answer to "how do I clean the filter?" — and most product questions don't need agentic retrieval. If adopted, gate agentic search behind classification, keep single-shot as the default path, and measure TTFT p50/p95 per path separately.

## Known gaps

- No online grounding evaluator. Pattern 2 (agentic on retry) assumes a confidence signal that doesn't exist yet — see `observability.md` for the online-eval roadmap.
- No multi-hop golden set. The current 25-question eval is PDP-single-answer; evaluating whether agentic search actually helps requires a different golden set (multi-hop, cross-section, decomposable).
- No TTFT-per-path benchmarking. If a router or agent loop is added, extend `tooling/evals/performance.ts` to measure p50/p95 TTFT for each path separately, not just the aggregate.
