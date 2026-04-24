# Quick Start

This project is split into two sibling Next.js apps that run together:

- **`product-insights-agent/`** — the widget bundle, chat API, RAG pipeline, guardrails, and control panel. Runs on `http://localhost:3000`.
- **`storefront/`** — an example retailer PDP that embeds the widget via `<script src=".../embed.js">`. Runs on `http://localhost:3001`.

## 1. Install dependencies

Install once per app:

```bash
cd product-insights-agent && pnpm install
cd ../storefront && pnpm install
```

## 2. Configure environment variables

From `product-insights-agent/`:

```bash
cp .env.example .env.local       # fill in API keys (see the Environment Variables section in product-insights-agent/README.md)
```

The default `MONGODB_URI` in `.env.example` (`mongodb://localhost:27017/product-insights`) matches the MongoDB instance started by `docker compose` in the next step — you can leave it as-is for local development.

## 3. Populate the vector store (first-time setup)

Before the agent can answer questions, the vector store needs to be populated by running the data ingestion pipeline. From `product-insights-agent/`:

```bash
docker compose up -d              # start MongoDB
pnpm pipeline:ingest --verbose    # auto-loads .env.local via tsx --env-file
```

See [Running the Data Ingestion Pipeline](product-insights-agent/README.md#running-the-data-ingestion-pipeline) for details.

## 4. Run both apps

In two terminals:

```bash
# terminal 1 — widget app (:3000)
cd product-insights-agent && pnpm dev

# terminal 2 — example storefront (:3001)
cd storefront && pnpm dev
```

## 5. Open the demo

- **[http://localhost:3001/](http://localhost:3001/)** — the example retailer PDP. The storefront fetches `http://localhost:3000/embed.js` and the widget mounts as a sandboxed iframe pointing at `http://localhost:3000/widget/host.html`.
- **[http://localhost:3000/demo/](http://localhost:3000/demo/)** — the widget embedded on a static example PDP served by the widget app itself (the site root `/` redirects here).
- **[http://localhost:3000/widget/host.html?productId=dreame-x40-ultra](http://localhost:3000/widget/host.html?productId=dreame-x40-ultra)** — the widget standalone (this is also what the demo PDP loads into its iframe).
- **[http://localhost:3000/controlpanel](http://localhost:3000/controlpanel)** — developer control panel: product selector, widget preview, event log (live SSE feed from `/api/events/stream`), API shortcuts. Dev-only; 404s in production builds.

## Pointing the storefront at a deployed widget

To point the storefront at a deployed widget instead of the local one, set `NEXT_PUBLIC_WIDGET_ORIGIN` in `storefront/.env.local`.
