# Seed Questions Guide

The seed question system generates, validates, caches, and rotates questions that appear on the chat widget's idle state, inviting shoppers to interact.

## How It Works

```
Product Data + Representative Chunks
        ↓
   LLM generates 10 candidates
        ↓
   LLM validates answerability against vector store
        ↓
   Valid questions cached in MongoDB (no TTL — persists until cleared)
        ↓
   Widget displays 3 at a time, rotating after interactions
```

## Generation Pipeline

`lib/seed-questions/generate.ts`

### Step 1: Candidate Generation

The system sends product context (name, brand, price, description, features) and representative chunks from the vector store to Claude Sonnet, requesting 10 diverse candidate questions. Questions must be:

- Concise (under 80 characters)
- Diverse (covering features, setup, maintenance, use cases)
- Engaging (encouraging clicks)
- Answerable from the product manual

### Step 2: Answerability Validation

A second LLM call evaluates each candidate question against the available document chunks. A question is answerable only if the chunks contain specific, relevant information to give a helpful answer without speculation. Questions about topics not covered in the documentation are filtered out.

### Step 3: Caching

`lib/seed-questions/cache.ts`

Validated questions are cached in the `seed_questions` MongoDB collection, keyed by product ID. The cache has no TTL — entries persist indefinitely and are only replaced by explicit re-generation (e.g. when the product manual is re-embedded). The cache structure:

```json
{
  "productId": "dreame-x40-ultra",
  "questions": [
    {
      "id": "uuid",
      "text": "How does the self-cleaning system work?",
      "productId": "dreame-x40-ultra"
    }
  ],
  "updatedAt": "2025-01-15T..."
}
```

## API Endpoint

`GET /api/seed-questions?productId=dreame-x40-ultra&clicked=id1,id2`

Returns 3 seed questions for the specified product. The `clicked` parameter excludes previously-clicked question IDs from the response.

### Response Flow

1. Check MongoDB cache for the product
2. If cache exists: return 3 questions, excluding clicked IDs
3. If cache is empty: return hardcoded fallback questions immediately, trigger background generation (fire-and-forget)
4. Background generation: run the full pipeline (generate → validate → cache), populating the cache for the next request. The cache is then reused forever until explicitly cleared (e.g. on re-embedding the product manual — out of scope for the demo).

## Rotation Logic

`src/server/seed-questions/rotation.ts`

- The widget tracks which question IDs the user has clicked (stored in a local JS array)
- Each request passes clicked IDs to the API via the `?clicked=` query parameter, which excludes them
- When fewer unclicked questions remain than `displayCount`, the server tops up the response with already-clicked questions to fill the slots. When the unclicked pool is fully drained, it returns the first `displayCount` from the full list. The widget's clicked list is not cleared — the server simply stops honouring the exclusion once the pool is exhausted.
- The widget displays 3 questions at a time from the available pool
- In the vanilla JS widget (`src/widget-vanilla/index.ts:101`), clicked-ID tracking lives in a closure-scoped array inside `init()` — it resets on full page reload but persists across questions within a single page session. The array is append-only; the widget never clears it.

> For production, this single-pool-with-fallback-to-repeats behaviour is not good enough — a returning shopper should never see a question they already clicked, and the pool should top up *before* it exhausts rather than repeating. See `docs/production-scaling/ingestion.md` § "Seed-question rotation + live regeneration" for the server-side rotation store + background top-up design.

## Fallback Questions

If the cache is empty and generation hasn't completed, the system immediately returns these hardcoded fallback questions:

1. "What are the key features of this robot vacuum?"
2. "How does the self-cleaning system work?"
3. "What surfaces can this vacuum clean?"
4. "How long does the battery last?"
5. "How do I set up the vacuum for the first time?"

These are defined in `lib/config.ts` under `seedQuestions.fallback`.

## Customization

### Changing the number of displayed questions

Edit `seedQuestions.displayCount` in `lib/config.ts` (default: 3).

### Changing the total generated candidates

Edit `seedQuestions.totalGenerated` in `lib/config.ts` (default: 10).

### Editing fallback questions

Edit `seedQuestions.fallback` in `lib/config.ts`. These should be product-specific questions that the RAG system can reliably answer.

### Cache lifetime

The cache has no TTL. Entries in the `seed_questions` collection are written on first request and reused forever until they are explicitly replaced. For production, the cache should be invalidated whenever the product's source documents are re-embedded — see `docs/production-scaling/ingestion.md` for the invalidation contract.

## Known gaps to close before production

- **Rotation state is client-managed.** The widget sends `?clicked=<ids>` on every fetch, and the API respects the exclusion list. If the widget resets without clearing the list (e.g. a SPA navigation that preserves local state), previously-seen questions stay excluded forever and the pool appears empty. Document the reset discipline in the widget code and consider server-side rotation tracking (`docs/production-scaling/ingestion.md` discusses the server-side rotation store).
- **`scripts/regenerate-seed-questions.ts` has no tests.** Edge cases — missing product, malformed markdown, partial validation failures — are covered in the library but not at the CLI surface. Add a small test for each flag combination before relying on it in CI.
- **Partial-write safeguard logs but doesn't alert.** If the validator rejects every generated question, the script writes an empty cache and subsequent requests serve fallback questions forever. The failure is logged but nothing pages. Add a `WARN` log level + an alert rule so a regeneration run that produces zero validated questions is noticed the same day.
- **Prompt-cache TTL is ~5 minutes.** Rare regeneration runs don't benefit from the `ephemeral` prompt cache on the full-document prefix — the cache expires between runs. For low-frequency regeneration this is a pricing asterisk: cost-per-regeneration is closer to the uncached rate than the cached rate. Document so teams modeling per-product costs don't undercount.
- **No integration between ingestion and seed-question invalidation for derived caches beyond `seed_questions`.** The pipeline clears `seed_questions` on re-ingest. If you add more derived caches (summary, topic tags, canned responses), each must be wired into the invalidation step — see `docs/production-scaling/ingestion.md` for the event-driven pattern that scales past two caches.
