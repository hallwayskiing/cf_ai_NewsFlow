# NewsFlow AI

NewsFlow AI is a serverless application built on Cloudflare Workers that aggregates trying trending tech news, summarizes them using AI, and presents them in a daily digest format.

## Features

-   **Automated Aggregation**: Fetches top trending tech stories from HackerNews (via Algolia), then retrieves main content through URL smartly.
-   **AI Summarization**: Uses Cloudflare Workers AI to generate concise one-sentence summaries for each story.
-   **Daily Digest**: Organizes news by day (today, yesterday, day before).
-   **Self-Updating**: Runs hourly via Cron Triggers to fetch fresh news.
-   **Static Frontend**: Includes a clean, responsive dashboard to view the news.

## Architecture

The project leverages the Cloudflare Developer Platform:

-   **Cloudflare Workers**: The core serverless compute environment.
-   **Workers AI**: Powered by Llama 3.3 for text summarization.
-   **Workflows**: Orchestrates the multi-step process of fetching, filtering, and summarizing news reliably.
-   **KV Storage**: Caches processed daily news data for fast retrieval.
-   **Cron Triggers**: Schedules the workflow to run automatically every hour.

## Project Structure

-   `src/index.ts`: Main worker logic, including the HTTP API, Cron handler, and Workflow definition.
-   `frontend/`: Static HTML/CSS/JS for the user interface.
-   `wrangler.jsonc`: Cloudflare Workers configuration.

## Demo

See [NewsFlow AI](https://newsflow-ai.ethannie88.workers.dev/) for a live demo.

## Setup & Development

### Prerequisites

-   Node.js & npm
-   Cloudflare Account

### Installation

1.  Clone the repository.
2.  Install dependencies:

```bash
npm install
```

3. Login to Cloudflare
```bash
npx wrangler login
```

4. Create Vectorize Index
```bash
npx wrangler vectorize create news-index --dimensions=768 --metric=cosine
```

5. Create KV Namespace
```bash
npx wrangler kv namespace create news-kv
```

### Deployment

To deploy the worker to your Cloudflare account:

1. Create a subdomain for your worker
```bash
npx wrangler subdomain create newsflow-ai
```

2. Deploy the worker
```bash
npm run deploy
```
