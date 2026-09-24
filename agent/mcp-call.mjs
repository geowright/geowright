#!/usr/bin/env node
// One MCP tool call per invocation against a Playwright MCP server running with --port.
// Usage: node agent/mcp-call.mjs <port> <tool|--list> ['<json args>']
// Lets an LLM agent that only has a shell use Playwright MCP's tools and nothing else.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const [port, tool, json] = process.argv.slice(2);
const url = `http://localhost:${port}/mcp`;
// agent/runs/ is git-ignored, so a fresh clone has none: made here, beside this script (not relative to the cwd).
const runs = fileURLToPath(new URL('./runs/', import.meta.url));
mkdirSync(runs, { recursive: true });
const sessFile = `${runs}.session-${port}`;
let session = existsSync(sessFile) ? readFileSync(sessFile, 'utf8').trim() : undefined;
let id = Date.now();

async function post(body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(session ? { 'mcp-session-id': session } : {}) },
    body: JSON.stringify(body),
  });
  const sid = res.headers.get('mcp-session-id');
  if (sid) session = sid;
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  if (!text) return undefined;
  const data = text.startsWith('{') ? text : text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).pop();
  return data ? JSON.parse(data) : undefined;
}

async function init() {
  session = undefined;
  await post({ jsonrpc: '2.0', id: id++, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcp-call', version: '0' } } });
  await post({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
  writeFileSync(sessFile, session ?? '');
}

async function request(body) {
  if (!session) await init();
  try {
    return await post(body);
  } catch (e) {
    await init(); // stale session
    return post(body);
  }
}

if (tool === '--list') {
  const r = await request({ jsonrpc: '2.0', id: id++, method: 'tools/list', params: {} });
  for (const t of r.result.tools) console.log(`${t.name}: ${(t.description ?? '').split('\n')[0]}  args=${JSON.stringify(Object.keys(t.inputSchema?.properties ?? {}))}`);
} else {
  const r = await request({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name: tool, arguments: json ? JSON.parse(json) : {} } });
  if (r.error) console.log('ERROR:', JSON.stringify(r.error));
  for (const c of r.result?.content ?? []) console.log(c.type === 'text' ? c.text : `[${c.type} content omitted]`);
}
