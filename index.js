import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ApifyClient } from 'apify-client';

const ACTOR_ID = 'apify/website-content-crawler';
const TEXT_LIMIT = 5000;
const MAX_PAGES_CAP = 50;

const ok = (payload) => ({
  content: [{ type: 'text', text: JSON.stringify({ status: 'ok', ...payload }, null, 2) }],
  isError: false
});

const err = (code, message, extra = {}) => ({
  content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: { code, message, ...extra } }, null, 2) }],
  isError: true
});

const server = new Server(
  { name: 'website-content-crawler-mcp', version: '1.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'crawl_website',
      description:
        'Crawl a website and extract page content by running the apify/website-content-crawler actor. ' +
        'Returns a fixed-shape envelope: {status, run:{id,status}, page_count, pages:[{url,title,text}]}. ' +
        'Requires APIFY_TOKEN in the environment.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to crawl (http/https)' },
          maxPages: { type: 'number', description: 'Maximum pages to crawl, capped at 50 (default 10)' },
          crawlerType: {
            type: 'string',
            enum: ['cheerio', 'playwright:chrome'],
            description: 'cheerio = fast/static and cheaper; playwright:chrome = JS-rendered sites (default cheerio)'
          }
        },
        required: ['url']
      }
    }
  ]
}));

async function crawlWebsite(args) {
  const { url, maxPages = 10, crawlerType = 'cheerio' } = args ?? {};

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return err('invalid_url', `Not a parseable URL: ${url}`);
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    return err('invalid_url', `Only http/https URLs are supported, got ${parsed.protocol || '(none)'}:`);
  }

  const token = process.env.APIFY_TOKEN;
  if (!token) {
    return err(
      'missing_token',
      'APIFY_TOKEN is not set in the environment. Create one at https://console.apify.com/settings/integrations and export it as APIFY_TOKEN.',
      { actor: ACTOR_ID, invoked: false }
    );
  }

  const client = new ApifyClient({ token });

  const runInput = {
    startUrls: [{ url }],
    maxCrawlPages: Math.min(Math.max(1, Math.floor(maxPages)), MAX_PAGES_CAP),
    maxCrawlDepth: 1,
    crawlerType,
    saveMarkdown: false,
    proxyConfiguration: { useApifyProxy: true }
  };

  let run;
  try {
    run = await client.actor(ACTOR_ID).call(runInput);
  } catch (e) {
    const authFailed =
      e?.statusCode === 401 || e?.status === 401 ||
      /401|unauthorized|authentication token/i.test(String(e?.message));
    const code = authFailed ? 'apify_auth_failed' : 'actor_run_failed';
    return err(code, e?.message ?? String(e), { actor: ACTOR_ID });
  }

  if (run.status !== 'SUCCEEDED') {
    return err('run_not_succeeded', `Actor run ${run.id} finished with status ${run.status}`, {
      actor: ACTOR_ID,
      runId: run.id
    });
  }

  const limit = runInput.maxCrawlPages;
  let dataset;
  try {
    dataset = await client.dataset(run.defaultDatasetId).listItems({ limit });
  } catch (e) {
    return err('dataset_fetch_failed', e?.message ?? String(e), { runId: run.id });
  }

  return ok({
    run: { id: run.id, status: run.status },
    page_count: dataset.items.length,
    total_in_dataset: dataset.total,
    pages: dataset.items.map((item) => ({
      url: item.url,
      title: item.title ?? null,
      text: typeof item.text === 'string' && item.text.length > TEXT_LIMIT
        ? item.text.slice(0, TEXT_LIMIT) + '…[truncated]'
        : item.text ?? null
    }))
  });
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'crawl_website') {
    return crawlWebsite(request.params.arguments);
  }
  throw new Error(`Tool not found: ${request.params.name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`Website Content Crawler MCP Server running on stdio (actor: ${ACTOR_ID})`);
