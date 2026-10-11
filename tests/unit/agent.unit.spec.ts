import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';

/** agent/: the scripts that let an LLM agent drive Playwright MCP. No network: a fake MCP server on loopback. */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const run = promisify(execFile);

test('mcp-call.mjs works in a fresh clone, where the git-ignored agent/runs/ does not exist yet', async () => {
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

test('the control arm hides the app\'s hook, the with-map arm does not', () => {
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

test('README "Agents": what it tells a package user to pass ships in the package, and its Chromium flags are the ones the repo runs with', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const section = readme.slice(readme.indexOf('## Agents'), readme.indexOf('\n## ', readme.indexOf('## Agents') + 1));
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { files: string[] };
  const shipped = [...section.matchAll(/node_modules\/geowright\/([\w./-]+[\w])/g)].map((m) => m[1]);
  expect(new Set(shipped)).toEqual(new Set(['dist/inpage.js', 'dist/inpage-agent.js', 'agent/MAP_SKILL.md']));
  for (const f of shipped) expect(pkg.files.some((p) => p === f || f.startsWith(`${p}/`)), `${f} is in package.json "files"`).toBe(true);
  const json = /```json\n([\s\S]*?)```/.exec(section)![1];
  const repo = JSON.parse(readFileSync(join(ROOT, 'agent/playwright-mcp.config.json'), 'utf8'));
  expect(JSON.parse(json).browser.launchOptions.args).toEqual(repo.browser.launchOptions.args);
  expect(section, 'repo-only commands belong under "Developing geowright"').not.toMatch(/npx esbuild|npm run build:inpage|agent\/playwright-mcp\.config\.json|agent\/init-page\.ts/);
});

// A stand-in for `npx @playwright/mcp`: MCP over stdio (newline-delimited JSON-RPC), first on PATH as `npx`.
// 'browser-missing' answers every tool call the way Playwright MCP does when the Chromium build it launches is not
// installed: a tool result with isError and the "### Error" text, not a JSON-RPC error.
const FAKE_MCP = `
const mode = process.env.FAKE_MCP_MODE;
const tools = ['browser_navigate', 'browser_evaluate', 'browser_mouse_click_xy'].map((name) => ({ name, inputSchema: { type: 'object' } }));
const ok = (text) => ({ content: [{ type: 'text', text }] });
function answer(method, params) {
  if (method === 'initialize') return { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '0' } };
  if (method === 'tools/list') return { tools };
  if (mode === 'browser-missing')
    return { content: [{ type: 'text', text: '### Error\\nError: Browser "chromium" is not installed; expected executable at /cache/chromium_headless_shell-1246/chrome-headless-shell. Run \`npx @playwright/mcp install-browser chromium\` to install' }], isError: true };
  const { name, arguments: a } = params;
  if (name === 'browser_navigate') return ok('### Page\\n- Page URL: ' + a.url);
  if (name === 'browser_mouse_click_xy') return ok('### Ran Playwright code\\nawait page.mouse.click(' + a.x + ', ' + a.y + ');');
  if (a.function.includes('modelContext')) return ok('### Result\\n"undefined"');
  if (a.function.includes('snapshot')) return ok('### Result\\n"map main\\\\n#1 Point @(640,360) severity=\\\\"high\\\\""');
  return ok('### Result\\n"<div data-testid=\\\\"popup\\\\">Gas leak</div>"');
}
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: answer(msg.method, msg.params) }) + '\\n');
  }
});
`;

async function runProbe(mode: 'browser-missing' | 'works'): Promise<{ code: number; out: string }> {
  const dir = test.info().outputPath(mode);
  mkdirSync(join(dir, 'bin'), { recursive: true });
  mkdirSync(join(dir, 'agent'), { recursive: true });
  cpSync(join(ROOT, 'agent/mcp-probe.mjs'), join(dir, 'agent/mcp-probe.mjs'));
  writeFileSync(join(dir, 'fake-mcp.mjs'), FAKE_MCP);
  writeFileSync(join(dir, 'bin/npx'), `#!/bin/sh\nexec "${process.execPath}" "${join(dir, 'fake-mcp.mjs')}" "$@"\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, FAKE_MCP_MODE: mode };
  try {
    const { stdout, stderr } = await run(process.execPath, ['agent/mcp-probe.mjs', '--caps=vision'], { cwd: dir, env, timeout: 30_000 });
    return { code: 0, out: stdout + stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

test('mcp-probe.mjs exits non-zero when a tool call fails, as every browser call does when MCP\'s own Chromium build is not installed', async () => {
  const failing = await runProbe('browser-missing');
  expect(failing.out).toContain('is not installed');
  expect(failing.code, failing.out).not.toBe(0);
  expect(failing.out).toMatch(/browser_navigate/);

  const working = await runProbe('works');
  expect(working.out).toContain('coordinate click on the high-severity alert at 640 360');
  expect(working.out).toContain('Gas leak');
  expect(working.code, working.out).toBe(0);
});

test('the first-time commands install the Chromium build Playwright MCP launches, which `npx playwright install` does not', () => {
  // @playwright/mcp depends on its own playwright-core, newer than @playwright/test's, and launches that copy's Chromium
  // build: with @playwright/mcp 0.0.82 (playwright-core 1.64.0-alpha, Chromium build 1246) beside @playwright/test 1.63
  // (build 1243), a checkout set up with `npx playwright install chromium` alone failed every MCP browser call with
  // 'Browser "chromium" is not installed'. The command MCP's error names installs its build; it is a no-op when present.
  const cmd = 'npx @playwright/mcp install-browser chromium';
  const section = (doc: string, heading: string) => {
    const at = doc.indexOf(`\n${heading}\n`);
    expect(at, heading).toBeGreaterThan(-1);
    return doc.slice(at, doc.indexOf('\n## ', at + 1));
  };
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const agents = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');
  expect.soft(section(agents, '## Commands'), 'AGENTS.md: Commands').toContain(cmd);
  expect.soft(section(readme, '## Developing geowright'), 'README: Developing geowright').toContain(cmd);
  expect.soft(section(readme, '## Agents (Playwright MCP)'), 'README: Agents').toContain(cmd);
});
