import { spawn } from 'node:child_process';

const SERVER = new URL('./index.js', import.meta.url).pathname;

let nextId = 1;
const pending = new Map();
let buffered = '';

const child = spawn('node', [SERVER], {
  env: { ...process.env, APIFY_TOKEN: '' },
  stdio: ['pipe', 'pipe', 'pipe']
});
child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

child.stdout.on('data', (chunk) => {
  buffered += chunk.toString();
  let idx;
  while ((idx = buffered.indexOf('\n')) !== -1) {
    const line = buffered.slice(0, idx).trim();
    buffered = buffered.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch { /* ignore partial */ }
  }
});

function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting for ${method}`));
    }, 10000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

const parseEnvelope = (res) => JSON.parse(res.result.content[0].text);

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`PASS ${name}`);
  else { failures++; console.log(`FAIL ${name} ${detail}`); }
};

const init = await rpc('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'smoke-test', version: '1.0.0' }
});
check('initialize', !!init.result?.serverInfo);

await rpc('notifications/initialized', {});

const list = await rpc('tools/list', {});
const tool = list.result?.tools?.find((t) => t.name === 'crawl_website');
check('tools/list exposes crawl_website', !!tool);
check('schema requires url', Array.isArray(tool?.inputSchema?.required) && tool.inputSchema.required.includes('url'));

// 1. unparseable URL -> structured error, NOT a success envelope
const r1 = parseEnvelope(await rpc('tools/call', {
  name: 'crawl_website',
  arguments: { url: 'not-a-url' }
}));
check('invalid_url envelope', r1.status === 'error' && r1.error?.code === 'invalid_url', JSON.stringify(r1));

// 2. non-http(s) scheme rejected
const r2 = parseEnvelope(await rpc('tools/call', {
  name: 'crawl_website',
  arguments: { url: 'ftp://example.com' }
}));
check('non-http scheme rejected', r2.status === 'error' && r2.error?.code === 'invalid_url');

// 3. valid URL + no token -> honest missing_token with invoked:false
const r3 = parseEnvelope(await rpc('tools/call', {
  name: 'crawl_website',
  arguments: { url: 'https://example.com', maxPages: 3 }
}));
check(
  'missing_token envelope is honest',
  r3.status === 'error' && r3.error?.code === 'missing_token' && r3.error?.invoked === false,
  JSON.stringify(r3)
);

// 4. no fabricated success shape anywhere in source
import { readFileSync } from 'node:fs';
const src = readFileSync(SERVER, 'utf8');
check(
  "no fabricated '{status:success,message:Crawler invoked successfully}' response",
  !/Crawler invoked successfully/.test(src)
);
check('source calls client.actor(...).call(...)', /client\.actor\(ACTOR_ID\)\.call\(runInput\)/.test(src));
check("success envelope uses status:'ok'", /status:\s*'ok'/.test(src));

child.kill();
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
