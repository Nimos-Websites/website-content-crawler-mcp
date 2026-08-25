# Website Content Crawler MCP Server

MCP wrapper that runs the **apify/website-content-crawler** actor for real via `apify-client`
and returns its pages as JSON. Every call either returns crawled content or a structured
error — it never reports a fake success.

## What it costs

Runs bill **your** Apify account at the rate listed for
[apify/website-content-crawler](https://apify.com/apify/website-content-crawler) — this
server adds nothing on top. No token, no charge: calls return `missing_token` before any
run starts.

Live output demo (same crawl logic, rendered): https://website-content-crawler.vercel.app

## Setup

```bash
npm install
export APIFY_TOKEN=apify_api_...   # https://console.apify.com/settings/integrations
npm start                          # stdio MCP server
```

## Tool: `crawl_website`

Input:

| field       | type   | default            | notes                                  |
|-------------|--------|--------------------|----------------------------------------|
| `url`       | string | required           | http/https URL to crawl                |
| `maxPages`  | number | 10                 | capped at 50                           |
| `crawlerType` | string | `cheerio`        | or `playwright:chrome` for JS-rendered |

Output envelope (same shape every call):

```json
{
  "status": "ok",
  "run": { "id": "<apify run id>", "status": "SUCCEEDED" },
  "page_count": 3,
  "total_in_dataset": 3,
  "pages": [{ "url": "...", "title": "...", "text": "...(≤5000 chars)" }]
}
```

Error codes: `invalid_url`, `missing_token`, `apify_auth_failed`, `actor_run_failed`,
`run_not_succeeded`, `dataset_fetch_failed`.

## Smoke test

```bash
printf '%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' \
 '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
 '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"crawl_website","arguments":{"url":"https://example.com"}}}' \
 | node index.js
```

With no `APIFY_TOKEN` set, request id 3 must return
`{"status":"error","error":{"code":"missing_token",...}}` — proof the handler reaches the
real Apify boundary instead of inventing a result.
