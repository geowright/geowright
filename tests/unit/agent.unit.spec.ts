import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';

/** agent/: the scripts that let an LLM agent drive Playwright MCP (G8, G9 of an earlier issue). No network: a fake MCP server on loopback. */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const run = promisify(execFile);

test('mcp-call.mjs works in a fresh clone, where the git-ignored agent/runs/ does not exist yet (G8)', async () => {
  const clone = test.info().outputPath('clone');
  mkdirSync(join(clone, 'agent'), { recursive: true });
  cpSync(join(ROOT, 'agent/mcp-call.mjs'), join(clone, 'agent/mcp-call.mjs'));
  // Just enough of the MCP streamable-HTTP transport: a session id on initialize, a tool list.
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const msg = JSON.parse(body);
      if (msg.id === undefined) return void res.writeHead(202).end();
      const result = msg.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake', version: '0' } } : { tools: [{ name: 'browser_navigate', description: 'Navigate to a URL', inputSchema: { properties: { url: {} } } }] };
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'session-1' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  try {
    const { stdout } = await run(process.execPath, ['agent/mcp-call.mjs', String(port), '--list'], { cwd: clone });
    expect(stdout).toContain('browser_navigate: Navigate to a URL  args=["url"]');
    expect(readFileSync(join(clone, `agent/runs/.session-${port}`), 'utf8')).toBe('session-1');
  } finally {
    server.close();
  }
});

test('the control arm hides the app\'s hook, the with-map arm does not (G9)', () => {
  const args = (arm: string): string[] => JSON.parse(readFileSync(join(ROOT, `agent/mcp.${arm}.json`), 'utf8')).mcpServers.playwright.args;
  const scripts = (arm: string) => args(arm).flatMap((a, i, all) => (all[i - 1] === '--init-script' ? [a] : []));
  expect(scripts('control')).toEqual(['agent/hide-hook.init.js']);
  expect(scripts('with-map')).toEqual(['dist/inpage.js']);
  for (const s of [...scripts('control'), ...scripts('with-map')].filter((p) => !p.startsWith('dist/'))) expect(existsSync(join(ROOT, s)), s).toBe(true);

  // What the init script does to an app: its one-line hook runs, and still no map is reachable.
  const page: Record<string, unknown> = {};
  page.window = page;
  runInNewContext(readFileSync(join(ROOT, 'agent/hide-hook.init.js'), 'utf8'), page);
  runInNewContext('const map = { a: "map" }; (window.__geowright_maps ??= {}).main = map;', page);
  expect(runInNewContext('window.__geowright_maps', page)).toBeUndefined();
});
