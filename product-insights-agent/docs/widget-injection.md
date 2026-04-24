# Widget Injection Guide

The Product Insights widget embeds into any storefront as a **sandboxed iframe** dropped in with a single `<script src="embed.js">` tag. No framework, no build step, no CSS or JS leakage between the widget and the host page.

## Overview

A retailer includes `embed.js` from the deployed Next.js app. The script reads `data-*` attributes from its own tag, creates an `<iframe>` pointing at `/widget/host.html?productId=…`, and mounts it in the page. The iframe loads the widget bundle (`widget.js` + `widget.css`) and calls `init()`. As the widget streams in answers and opens modals, it posts `{ type: "product-insights:resize", height }` to its parent, which resizes the iframe so there's never an internal scrollbar.

The iframe talks to the app's `/api/chat` (streaming RAG) and `/api/seed-questions` endpoints on the same origin. The retailer's page never sees the widget's JS globals, CSS classes, or runtime errors.

## Prerequisites

- A deployed instance of this Next.js app (the app origin; also what `apiBase` resolves to)
- The product ID as it appears in `data/products/*.json` (e.g. `dreame-x40-ultra`)

## Quick Start — `embed.js`

One script tag is all a retailer needs. The loader derives the app origin from its own `src`, so updating the widget on the server is transparent — the retailer's snippet stays unchanged forever.

```html
<div id="product-insights"></div>
<script
  src="https://your-deployment.vercel.app/embed.js"
  data-product-id="dreame-x40-ultra"
  data-mount="#product-insights"
  data-client-id="optional-analytics-id"
></script>
```

If `data-mount` is omitted, the iframe is inserted immediately after the script tag, which is often what you want for a "drop here" integration.

For local dev, point the `src` at `http://localhost:3000/embed.js`.

## Configuration Reference

`embed.js` reads these attributes from its own `<script>` tag:

| Attribute         | Required | Description                                                                                                                                                                              |
| ----------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `data-product-id` | Yes      | The product ID to load seed questions and answers for                                                                                                                                    |
| `data-mount`      | No       | CSS selector for the element to inject the iframe into. If omitted, the iframe is inserted immediately after the script tag.                                                             |
| `data-api-base`   | No       | Override the app origin. Normally omitted — the script derives it from its own `src`. Only set when the `embed.js` bundle is served from a different host.                               |
| `data-client-id`  | No       | Non-PII analytics identifier forwarded into every widget event (`/api/events`). Intended for joining widget activity to the storefront's own analytics session (GA4 / Segment / etc.). See [production-scaling/analytics.md](production-scaling/analytics.md). |

The iframe is created with `sandbox="allow-scripts allow-same-origin allow-forms"`. `allow-same-origin` is required for streaming `fetch` and for the iframe's widget to persist its seed-questions cache; because the iframe is same-origin with the Next.js app (not the retailer's page), this does not give it access to the retailer's cookies or storage.

## GTM Injection

To inject the widget via Google Tag Manager without touching the storefront code:

1. Create a new **Custom HTML** tag in GTM.
2. Paste the following, replacing placeholders with a GTM variable or hard-coded product ID:

   ```html
   <div id="product-insights"></div>
   <script
     src="https://your-deployment.vercel.app/embed.js"
     data-product-id="{{DL - Product ID}}"
     data-mount="#product-insights"
   ></script>
   ```

3. Set the **Trigger** to fire on PDP page views (e.g. a Page Path trigger matching `/products/*`).
4. Set the **Tag firing options** to **Once per page**.

Because the widget runs inside an iframe, it doesn't compete with the retailer's own `fetch` monkey-patches, error trackers, or global scripts.

## Mount Target Options

`embed.js` resolves the mount location in this order:

1. `data-mount` — CSS selector on the parent page
2. Immediately after the `<script>` tag itself (creates its own container)

The iframe fills 100% width of its mount element and grows to fit its content height.

## CORS

Both `/api/chat` and `/api/seed-questions` respond with:

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: POST, OPTIONS  (chat) / GET, OPTIONS  (seed-questions)
Access-Control-Allow-Headers: Content-Type
```

This is intentional for the demo so any storefront can embed the widget without configuring an allowlist. **Before production**, restrict `Allow-Origin` to known retailer domains. (The iframe-to-parent `postMessage` channel does not go through CORS — it's origin-checked in-script.)

## Analytics events

The widget emits typed analytics events at six lifecycle points: seed questions load, question submit, answer start, answer complete, answer error, and disclaimer open. Events POST to `/api/events` on the widget origin (same-origin from inside the iframe), fire-and-forget, with `keepalive: true` so events fired on unload still go.

Each event carries a widget-minted `sessionId` (scoped to the browser tab), a `productId`, a `type`, and a `ts`. If the retailer sets `data-client-id` on the embed tag, that value rides along on every event so retailer-side joins back to the storefront's own analytics session work without exposing PII.

```html
<div id="product-insights"></div>
<script
  src="https://your-deployment.vercel.app/embed.js"
  data-product-id="SKU-12345"
  data-client-id="retailer-acme-prod"
></script>
```

Full guide: [production-scaling/analytics.md](production-scaling/analytics.md).

## Customization — themeing

With iframe isolation, retailer CSS cannot touch `.pi-*` widget classes — that's the whole point of the isolation. To re-theme, forward values into the widget URL and have the widget read them into CSS variables. As a future enhancement, expose `data-accent-color`, `data-font` etc. on the `<script>` tag so `embed.js` forwards them to the iframe. The widget currently only honours `productId`.

## Troubleshooting

### Widget doesn't appear

- Check the browser console for errors from `embed.js`.
- Confirm `embed.js` loaded (Network tab — look for the file and status 200).
- Confirm the `data-mount` element exists before the script runs, or omit `data-mount` to let the script inject the container itself.
- Confirm the iframe's `src` resolves (open the URL directly — `https://your-deployment.vercel.app/widget/host.html?productId=…` should render the widget standalone).

### Iframe stays 150px tall / doesn't resize

- Open the parent page's console. `embed.js` sets `iframe.style.height` on every `product-insights:resize` message. If no messages arrive, the widget either isn't mounted or ran into an error before wiring the ResizeObserver.
- Confirm the iframe's origin matches the `embed.js` origin — the resize listener filters by origin.
- Open the iframe's console (right-click inside the iframe → Inspect) and check for errors from `ProductInsightsWidget.init`.

### CORS errors in the console

- Verify the `embed.js` `src` is the full deployed URL including `https://` and no trailing slash.
- Check that the deployment is live and `/api/health` is reachable (`curl https://your-deployment.vercel.app/api/health`).

### Seed questions show "What are the key features…" fallbacks

- The MongoDB cache is empty — the background generation job hasn't completed yet. Wait ~30s and reload; the cache populates on first request.
- If fallbacks persist, check that `MONGODB_URI` is set in the deployment environment and the pipeline has been run (`pnpm pipeline:ingest`).

### Widget renders but answers don't stream

- Open the Network tab (inside the iframe devtools) and click a seed pill. Look for the `/api/chat` request.
- A `400` usually means `productId` is wrong or the message was blocked by a guardrail.
- A `500` usually means an LLM API key is missing from the deployment environment.
