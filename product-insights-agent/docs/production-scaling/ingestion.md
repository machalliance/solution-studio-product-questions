# Ingestion

Scaling ingestion beyond a single demo product means treating the vector store and any derived caches as a coupled system. Anything generated _from_ the embeddings (seed questions, summaries, routing hints) has to be invalidated whenever the source documents change.

## Principle: source-document changes invalidate derived caches

Ingestion produces two things downstream features read:

- **Embeddings** — the `chunks` collection; the raw RAG corpus.
- **Derived artifacts** — today just `seed_questions`, but in production this list grows (topic tags, summaries, canned responses, router classifications).

Rule: whenever a product's source documents change, every derived artifact for that product must be cleared. Otherwise the UI surfaces stale suggestions that contradict retrievable content, and answers silently disagree with the seeded questions. The demo deliberately has no TTL — entries persist until explicitly replaced. That's correct; a TTL would only mask the missing invalidation contract.

## Priorities at a glance

| # | Problem | Priority |
|---|---|---|
| 1 | No invalidation contract between ingestion and derived caches | P0 |
| 2 | Bring-your-own product data adapter (commercetools / Shopify / PIM) | P1 |
| 3 | No per-stage retry + checkpointing (only contextualizer retries) | P1 |
| 4 | Seed-question rotation + live regeneration | P1 |
| 5 | Eval scaling: per-product → representative → synthetic + online | P1 |
| 6 | Seed-question generator context-window limits on large docs | P2 |
| 7 | Eval maturity (golden-set size, stratification, SME review, judge reliability) | P2 |
| 8 | Retrieval stack upgrades (hybrid, reranker, late chunking) | P2 |

`productId` tampering lives with the signed-page-context story in `embed-security.md`.

## No invalidation contract between ingestion and derived caches (P0)

Treat the ingestion pipeline as the owner of the invalidation contract. At the end of a successful re-ingestion of product `X`, the same run deletes every derived artifact keyed on `X`.

- Event-driven: publish a `product.documents.updated` event on successful re-ingestion; each derived cache subscribes and clears its own rows. New caches just subscribe — the ingestion job doesn't grow a list.
- Versioned keys: store a `documentsVersion` (hash of source docs) on each product; every derived row carries the version it was generated against. A cheap comparison on read detects staleness without a coordinated flush.
- Pre-warm by calling the seed-question generator synchronously before the pipeline exits, so the first shopper after ingestion doesn't hit fallback questions.

## Bring-your-own product data adapter (P1)

Ingestion reads the structured product record (name, price, features, specs) through a `ProductDataAdapter` interface and synthesizes "product card" chunks into the same vector collection. The demo's `FileProductDataAdapter` reads `data/products/<productId>.json`. Every other read path (chat route, seed-question generator, PDP render) already goes through the adapter, so swapping data sources is a one-class change.

- commercetools: wrap `ProductProjection.byKey`; map `masterVariant.attributes` into `specifications`, `name[locale]` into `name`.
- Shopify: use the Storefront API `product(handle:)` query; flatten `variants` into `specifications`.
- Any PIM: the interface is one method (`getProduct(id) → ProductData`) — easy to implement against an internal PIM without touching the pipeline, chat route, or widget.

Each chunk is inserted with a top-level `productId` field declared as a vector-search `filter`, so a catalog with thousands of SKUs can share one `chunks` collection — the filter is applied before ANN, so latency scales with one product's vectors, not the whole collection.

## No per-stage retry + checkpointing (P1)

Only `contextualize.ts` implements retry with backoff. Extraction and embedding fail the whole run on a single transient provider error; for multi-hour ingestion runs, restarting from step 1 is expensive.

- Bounded retry at each stage with a persisted checkpoint so a failure mid-ingestion resumes from the last completed stage.
- Log cost per stage (tokens and dollars) per source type so `$/document` is knowable broken out by PDF vs. HTML vs. PIM field.

## Seed-question rotation + live regeneration (P1)

Demo fetches the cached pool on mount and shows the first three; a returning shopper sees the same three every time. Design for two concerns separately: **rotation** (what this user sees) and **regeneration** (how the pool stays deep).

- Track clicks per session (cookie or anonymous device ID, no PII) and filter out already-clicked IDs before returning. Decay the seen set after ~30 days.
- Never re-show a clicked question while the user's identifier is live; the demo's `rotation.ts` falls back to already-clicked when the unseen pool thins — in production that's a regression users notice.
- Regenerate on a schedule (nightly for active PDPs) as a background job, never synchronously on shopper traffic. Kick off top-ups at a comfortable buffer (e.g. 2× `displayCount`), not at exhaustion — otherwise the next request sees the fallback list at exactly the moment they're most engaged.
- Append, don't replace, on top-up; pass the current pool to the generator as "avoid these." The pool grows with user demand on the product.
- Distributed lock keyed on `seed:regen:{productId}` prevents thundering herds; fail soft on regeneration errors (keep serving the prior pool, don't empty it).

## Eval scaling: per-product → representative → synthetic + online (P1)

Per-product golden sets (the demo) work up to ~5 products, then break: cost scales linearly (100 products × 25 pairs × 3 judges × 9 grid cells ≈ 67,500 LLM calls per sweep), nobody reads 2,500 questions, and Day-1 launches have no history. Auto-generated goldens re-derived from the same source used for retrieval are a closed loop — they structurally cannot catch "the new content is worse than the old content."

The production default is three tiers, layered:

- **CI tier (every PR)** — synthetic pipeline eval on 3–5 synthetic docs (~30 questions), <2 min, <$1. Catches chunking regressions, embedding bugs, metadata drift.
- **Release tier (nightly / pre-release)** — 5–15 **representative** products with 50–100 SME-reviewed goldens each. Stratify the sample by source format, length, language, technical density, and regulated-content-type; sample bias (all PDFs, no HTML) becomes pipeline blindness.
- **Production tier (live traces)** — online evaluators (e.g. LangSmith / Phoenix / Langfuse) on ~5% sampled traffic, LLM-as-judge against the final output. Catches real-world drift without a golden set.

Chunk-param selection is a one-time offline calibration against the representative sample; don't re-run the grid sweep on a schedule. Re-run it as an event — when a new source format, language, or document class enters the catalog, signalling the sample drifted.

## Seed-question generator context-window limits on large docs (P2)

The generator passes the full product markdown with ephemeral prompt caching. Clean at ~30KB per doc; breaks on multi-hundred-page manuals, consolidated multi-SKU PDFs, translated bundles, sprawling HTML trees, long-form transcripts, or PIM "long description" fields carrying a white paper.

- Size-guard + map-reduce: measure token count after normalization to Markdown; below a threshold (e.g. 150K tokens with headroom) use the full-document path, above it generate candidates per-section and merge with dedup.
- Section-level summarization at ingestion: pre-summarize each section into a compact brief (1–2K tokens) that the generator reads instead of the raw doc. Trades one-time ingestion cost for predictable per-generation cost.
- Retrieval-augmented generator: keep the generator on retrieved chunks but raise `topK` (50–100) and diversify the retrieval queries (one per topic area). Cheaper but reintroduces the blind-spot risk the full-document approach fixed.
- Hybrid: full-document for below-threshold products, map-reduce for the long tail.

Measure token count per source type during ingestion regardless of strategy.

## Eval maturity (P2)

- Grow goldens to 50–100 per representative product. Statistical swing on 25 is ±8% per flip; 50–100 drops that to ±2–3%.
- Stratify by question bucket (factoid, multi-hop, procedural, out-of-scope, adversarial/refusal) and report per-bucket scores; aggregate hides "multi-hop is at 40% while factoid is at 92%."
- SME review every golden at production scale. The person who knows the product confirms the question is realistic and the expected answer is correct.
- Add `answer_relevancy` and an end-to-end hallucination check (LLM judge comparing final-answer claims to retrieved context). Different failures than retrieval metrics, different mitigations.
- Per-question regression deltas against prior-run scores, not just the aggregate threshold; catches silent per-question regressions that thresholds smooth over.
- Judge reliability: calibrate the judge against human labels (Cohen's kappa); use a multi-judge panel for scores near the decision boundary; store the judge's model ID + version and alert when the score distribution on a fixed golden set shifts meaningfully.

## Retrieval stack upgrades (P2)

- Hybrid search. MongoDB Atlas supports `$search` (Lucene BM25) alongside `$vectorSearch`; combine with reciprocal rank fusion. Vector search loses on exact-match queries (SKUs, part numbers, error codes).
- Reranker. Retrieve top-20 with vector+BM25, rerank to top-5 with a production reranker (e.g. Cohere Rerank 3.5, BGE, Voyage). Single highest-lift addition per Anthropic's own contextual-retrieval numbers.
- Late chunking (Jina, NAACL 2025). Embed the full document, split the embedding vector by token offset — similar anaphora-resolution benefit without the per-chunk LLM call, cheaper and simpler.
- Query rewriting for conversational surfaces. If the widget ever grows follow-ups (the current stateless design avoids this), rewrite the query against conversation history before retrieval — HyDE is the common variant for product-manual corpora.
