# Prompt management

The demo stores every prompt both in LangSmith Hub and as a hardcoded fallback in `lib/prompts/hub.ts`. The subtlety — and the part that needs deliberate operational discipline in production — is that **the hub is canonical in prod and the fallback is a resilience floor, not a mirror of the hub**. This doc covers how a production team runs that split.

## Principle: hub canonical in prod, fallback is the dev source of truth

`pullPrompt(name)` resolves by environment:

- `NODE_ENV=production` → pull from LangSmith Hub; on unreachable hub, unparseable manifest, or cold cache miss, fall back to `FALLBACK_PROMPTS`.
- Anywhere else (dev, test, preview) → return `FALLBACK_PROMPTS` directly; the hub is not consulted.
- Override: `LANGSMITH_PROMPT_SOURCE=hub` forces the hub path outside production; `=local` forces the fallback path in production (for smoke-testing the floor).

Three implications:

- Editing `FALLBACK_PROMPTS` in a PR changes dev immediately and changes prod only during hub outages. Promoting to prod means also pushing to the hub (via the CI `prompts:push` job or manually) so the hub serves the new version.
- Editing a prompt in the LangSmith UI immediately affects prod (after cache TTL expiry) without redeploy. That's the feature that makes the hub canonical for prod.
- Tests exercise the fallback (vitest sets `NODE_ENV=test`). Green tests prove the fallback is correct, not that the hub-served prompt is correct.

This is the same split Langfuse, LangSmith, Braintrust, and PromptLayer converge on. The opposite model (code canonical, hub mirrors it) exists — Humanloop's `.prompt` files — but this reference architecture is aligned with the registry-as-canonical camp and should stay that way.

## Priorities at a glance

| # | Problem | Priority |
|---|---|---|
| 1 | No CI drift check between hub and `FALLBACK_PROMPTS` | P0 |
| 2 | No persona-split governance (who edits where) | P1 |
| 3 | No tag-based promotion wiring (`staging` / `production`) | P1 |
| 4 | Cache TTL tuning for your traffic shape | P2 |

## No CI drift check between hub and `FALLBACK_PROMPTS` (P0)

Because the hub wins when reachable, drift between the hub-served prompt and the in-repo fallback is the **expected** state — prompts iterate in the hub at a higher cadence than code gets deployed. The failure mode: weeks of drift go unnoticed, LangSmith has an outage, and users see a prompt that diverged months ago from what the hub had been serving.

The demo implements an on-boot dev-time check (`lib/prompts/dev-check.ts`) that pulls each `:latest` from the hub and exact-string-matches against `FALLBACK_PROMPTS`, logging `in sync` / `drifted` / `not found` / `unreachable` for each prompt. The check is fire-and-forget and no-ops in production.

- Extend the same pattern into CI as a scheduled job (daily or weekly) that pulls each `:production` prompt and diffs against `FALLBACK_PROMPTS`.
- Warn when drift exceeds a threshold (e.g. 20% character edit distance); do not fail the build — the fallback is allowed to be old, it just shouldn't be embarrassingly old.
- Open an auto-PR that overwrites the fallback with the current `:production` text for a human to review.

Do **not** wire a CI job that pushes `FALLBACK_PROMPTS` to the hub on deploy. That's the Humanloop model and it fights the grain — it silently overwrites PM edits and gives up the fast-iteration loop that's the point of having a hub.

## No persona-split governance (P1)

Prompt ownership splits along edit medium.

| Persona | Edits | Review |
| --- | --- | --- |
| Engineers | `lib/prompts/hub.ts` in git | Pull request, code review |
| PMs / SMEs | LangSmith UI playground | Hub commit history, A/B against goldens |
| Both together | LangSmith tag promotion | Re-tag is logged and reversible |

- Engineers do not edit prompts in the hub UI. UI edits bypass code review and can't be grep'd later. Engineers change prompts by editing `FALLBACK_PROMPTS`, getting it reviewed, and pushing the merged version to the hub so the hub matches.
- PMs / SMEs do not edit `FALLBACK_PROMPTS`. The fallback is code; it has tests and reviewers. The hub UI is where they iterate, A/B, and commit.
- Promotion — moving a hub commit to the `production` tag — is a deliberate, auditable step; the approval workflow lives in the team's policy, not in LangSmith's data model.

## No tag-based promotion wiring (P1)

`pullPrompt(name, options)` resolves the tag from `options.tag` → `LANGSMITH_PROMPT_TAG` → `"latest"`. Recommended wiring:

| Environment | Tag | Why |
| --- | --- | --- |
| Local dev | unset (→ `latest`) | See playground edits immediately |
| Staging | `staging` | Validate a prompt before prod |
| Production | `production` | Pin prod to a promoted commit; UI edits don't auto-ship |

Rolling back a bad prompt change in prod is moving the `production` tag to the previous commit in the UI — no redeploy, no code change. For high-risk prompts, pin to a specific commit hash instead of a label so the prompt is immutable for that deployment.

## Cache TTL tuning (P2)

`pullPrompt` uses stale-while-revalidate with an in-process cache (fresh hit within TTL → cached value; stale hit → cached value + background refresh; cold start → await fetch or fallback). The cache is keyed by `name:tag`.

- Default `PROMPT_CACHE_TTL_MS` is 60000. Raise it (e.g. 300000+) on chatty deployments where per-hub-call latency matters; the trade-off is UI edits take longer to roll out across the fleet.
- Don't set it to multi-hour values. An infinite TTL means UI edits take hours to roll out and bad prompts can't be rolled back with a re-tag without waiting for restarts — 60 seconds is the industry default for a reason.
- Set it to 0 for tests or whenever every edit must be live.

## What not to do

- Don't edit prompts in the hub UI as an engineer, even "just this once" — it breaks the audit trail.
- Don't introduce a second prompt store (Mongo, Redis, Contentful). Every extra store is another source of drift; if LangSmith doesn't give you what you need, evaluate switching registries rather than stacking them.
- Don't skip the fallback because "fail-closed is better." For a reference architecture availability > freshness is the right default, but document it explicitly — it's a real design tension worth owning.
