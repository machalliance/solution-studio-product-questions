# Guardrails

The demo ships four guardrail layers with a deliberate ordering: a deterministic regex guard runs _before_ any LLM call, so a detected prompt-injection payload never reaches any model in the system. Routing decisions that require reading meaning (is this a harm report or a product question?) are LLM-based — but only on inputs the deterministic guard has already cleared.

| Demo layer            | Primary control                         | OWASP         |
| --------------------- | --------------------------------------- | ------------- |
| 1. Input validation   | Regex + normalization                   | LLM01 / LLM04 |
| 2. In-context defense | `<untrusted-input>` wrapping            | LLM01         |
| 3. Topical routing    | `gpt-5-nano` sensitive-topic classifier | LLM05         |
| 4. Output validation  | Regex scan (observability-only)         | LLM05         |

## The Layer 1 fail-closed guarantee

Detected prompt-injection payloads never reach _any_ LLM in this system. `checkPatternGuard` runs on raw user input before the chat route calls anything downstream. On a SECURITY match, the route returns HTTP 400: no retrieval embedding, no escalation classifier, no answering model, no tool calls. Brand-voice overrides short-circuit on the same path with a softer response; the raw user string still never reaches an LLM.

This is the load-bearing invariant. The OWASP/NIST argument for deterministic guards ("an LLM-based guard can itself be jailbroken") only pays off if the deterministic guard runs _before_ any LLM. A post-hoc LLM-based injection detector is a category error — by the time it runs, the attacker has already talked to the model.

## Priorities at a glance

| #   | Problem                                                                 | Priority |
| --- | ----------------------------------------------------------------------- | -------- |
| 1   | Rate limiting / abuse control — see `embed-security.md`                 | P0       |
| 2   | Output filter is observability-only, not blocking                       | P1       |
| 3   | No jailbreak evals in CI                                                | P1       |
| 4   | No guardrail routing evals (classifier drift)                           | P1       |
| 5   | Prompt-injection defense beyond regex (tag forgery, indirect injection) | P2       |

## Rate limiting / abuse control (P0)

See `embed-security.md` for the canonical problem description. Guardrails depend on rate limits as the damage cap when every other layer fails.

## Output filter is observability-only, not blocking (P1)

`post-check.ts` scans the completed response for competitor mentions and unsupported safety claims, but logs only — the response has already streamed. Upgrading to a gate is a UX trade-off worth naming:

- A moderation API (e.g. Llama Guard, OpenAI Moderation, Azure Content Safety) called before streaming begins, or token-level filtering on a sliding window to preserve TTFT.
- Two-pass generation: generate to a buffer, scan, then stream on pass or swap to a canned response on fail.
- Tune against real traffic in observability-first mode before turning enforcement on; a false-positive block equals an empty answer equals a support ticket.

## No jailbreak evals in CI (P1)

The pattern guard has unit tests on a handful of known-bad phrases. Jailbreak coverage needs a real suite.

- Continuous red-team evals in CI covering published jailbreak corpora (e.g. DAN variants, roleplay, encoding attacks) and domain-specific attacks.
- A jailbreak-rate metric tracked alongside retrieval quality so regressions show up in the same dashboard.
- A private seed set of internally-discovered attacks that never leaves the repo — don't let attackers train against the eval corpus.

## No guardrail routing evals (P1)

The escalation classifier has unit tests that mock `generateText` — they verify the category → message mapping, not the model's judgment. Whether the classifier correctly routes "it ran over my dog" to `safety-incident` rather than `safety-hazard` or `none` has no automated coverage.

- Labeled routing-eval set alongside retrieval goldens; each item `{ question, expected_category, expected_isSensitive }`. Seed with adjacent-category confusables, real incident reports, and adversarial phrasings (hypotheticals, other languages, user-supplied category hints).
- Run the real classifier (no mocks) in CI; gate on per-category precision/recall. Tune safety categories for high recall.
- Track routing accuracy in the same dashboard as retrieval quality and jailbreak rate so classifier drift (model upgrades, prompt edits) is visible.

## Prompt-injection defense beyond regex (P2)

Demo today: pre-LLM regex + `<untrusted-input>` wrapping + an explicit trust hierarchy in the system prompt. Covers the common shapes but not indirect injection (via retrieved content) or tag forgery.

- Tag-forgery detection. `pattern-guard.ts` flags `</?system>` but doesn't detect attempts to forge the custom tags this prompt uses (`<untrusted-input>`, `<context>`, `<product-info>`). Expand the delimiter regex to strip or reject those literal names so an attacker can't close the untrusted block early.
- Retrieval-time injection scanning. Run the same pattern guard on retrieved chunks. An attacker who can write into the corpus (e.g. a product review, a PIM field) can injection-attack via retrieval.
- Techniques like [Spotlighting](https://arxiv.org/abs/2403.14720) — deterministic transforms that teach the model "this is data, not instructions" — are worth evaluating once the indirect-injection attack surface grows.
