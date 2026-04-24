# Embed security

The widget ships as a sandboxed iframe injected via `<script>`. That isn't just code isolation — the iframe is a **trust boundary**: independent origin, independent CSP, independent JS context. Adopters get three properties that matter even for a single-team deployment:

- The agent ships on its own release train, independent of the storefront's.
- A storefront XSS can't compromise the widget, and widget bugs can't reach the storefront's JS context.
- Teams that can't land PDP code changes quickly can still adopt by dropping a single `<script>` tag.

This doc covers the gaps between the demo's trust story and what a team running the agent for their own product should land before a real launch. The demo's shared-secret pattern still has a caveat even for single-team adopters — the PDP HTML is served to anonymous browsers, so a static secret in it gives exactly as much security as the page serving it. The fix is server-minted HMAC session tokens, not multi-tenant publishable-key machinery.

## Priorities at a glance

| # | Problem | Priority |
|---|---|---|
| 1 | Rate limiting at multiple granularities | P0 |
| 2 | Static shared secret in publicly-served HTML → server-minted HMAC session tokens | P0/P1 |
| 3 | Iframe hardening (sandbox attrs, postMessage origin, CSP, `productId` binding, iframe behavior quirks) | P1 |
| 4 | Bot detection on expensive LLM calls | P2 |

## Rate limiting at multiple granularities (P0)

No auth layer is load-bearing without rate limits; this is the damage cap when every other layer fails. This is the canonical home for the rate-limiting problem — `analytics.md` and `guardrails.md` cross-reference here.

- Per-IP and per-session limits at the edge (e.g. Vercel KV, Upstash Redis, Cloudflare Rate Limiting, or an API gateway).
- Per-session message budget (e.g. N messages / hour / session).
- Global cost budget with automatic circuit-breaker short-circuit when spend crosses a threshold; `/api/chat` is disproportionately expensive (retrieval + generation + classification, all billable).
- Rule of thumb: an unauthenticated public endpoint needs at least two independent limiters (IP + session), because either alone is trivial to bypass.

## Static shared secret → server-minted HMAC session tokens (P0/P1)

The demo's embed secret is exposed to every browser that renders the PDP — it travels in HTML, URL params, and request headers. That's acceptable in the demo because the storefront sits behind Vercel Deployment Protection, so every browser reading the secret has already passed auth. Once the storefront goes public, View Source gives an attacker the key and they can hit `/api/chat` from anywhere.

The production-grade pattern: the storefront's server mints a short-lived signed token on every page render using a secret only its backend knows. The widget embeds the token; every API call carries it; the widget API verifies signature, expiry, and embedded claims (`productId`, `exp`, `iss`). The signing secret never touches the browser — client code can use a token the server minted, it cannot mint its own. Intercom Identity Verification and Plaid's `link_token` both ship this pattern.

- An attacker who scrapes the page gets a token valid for minutes, for one product; they can't mint new ones.
- The signing secret is rotatable without a widget redeploy; revocation is a secret rotation on the storefront.
- Replay-based scraping is detectable as a recognizable traffic pattern (fresh tokens on a schedule).
- Cost: adopters need a server route that mints tokens. The drop-a-`<script>`-tag story becomes drop-a-tag-plus-add-a-server-route — standard for serious embeds and worth the ergonomic hit.

## Iframe hardening (P1)

The iframe removes a large class of integration bugs (CSS collisions, JS conflicts, shared error surface). The iframe itself still has production gaps orthogonal to the token layer above.

- Sandbox attribute. Current is `sandbox="allow-scripts allow-same-origin allow-forms"`. `allow-scripts` is non-negotiable. `allow-same-origin` is required for streaming `fetch` on the widget's own origin and doesn't grant access to the retailer's cookies (the iframe is same-origin with the widget's Next.js app, not the retailer's page). Drop `allow-forms` if the widget's `<form>` submit is ever replaced with a plain handler.
- postMessage origin validation. `embed.js` filters inbound messages by `event.origin`. Tighten the widget side too — it currently posts with target origin `"*"` for demo simplicity. Use the app origin so a hostile iframe sibling can't spoof resize messages.
- CSP directives on the host page. Retailers with strict CSP need `frame-src` (or `child-src`) for the widget origin; they do **not** need `script-src`, since the embed snippet only injects an iframe. Document this in the integration guide.
- `productId` tampering. `POST /api/chat` accepts `productId` from the client today. Inject it server-side on PDP render from a signed page context (e.g. a short-lived token containing `{ productId, exp }`) and verify before retrieval. This is the minimum origin-binding story for a multi-product catalog and is independent of the HMAC session token above. This is the canonical home for the `productId` tampering problem — `ingestion.md` cross-references here.
- Iframe behavior quirks. Third-party cookies are blocked by default in Safari ITP / Firefox ETP; today's flows don't use cookies, so any future personalization has to pass context via `data-*` or the Storage Access API. `embed.js` sets initial `height: 0` to avoid a default-iframe flash; if the widget JS fails to load (network or CSP rejection), the iframe stays invisible — add a timeout fallback that sets a minimum height and logs an error.

## Bot detection on expensive LLM calls (P2)

A determined attacker with a valid session token and a fresh token per request still gets through rate limits on the margin. LLM inference is disproportionately expensive relative to HTTP; bot detection flips the economics.

- A silent browser-fingerprint challenge (e.g. Cloudflare Turnstile, Vercel BotID, reCAPTCHA Enterprise) invoked on the first message of a session or when anomaly scoring flags the session as likely-automated.
- Attacking now costs the attacker real money per request; defender's cost stays flat.

## References

- [OWASP API Security Top 10](https://owasp.org/API-Security/editions/2023/en/0x11-t10/) — API2 (Broken Authentication), API4 (Unrestricted Resource Consumption).
- [OWASP LLM Top 10](https://genai.owasp.org/llm-top-10/) — LLM04 (Model Denial of Service).
- [Intercom Identity Verification](https://www.intercom.com/help/en/articles/183-enable-identity-verification-for-web-and-mobile) — the HMAC session-token pattern, documented for customers.
