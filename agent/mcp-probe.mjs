// Minimal MCP stdio client (newline-delimited JSON-RPC) to probe Playwright MCP without an LLM:
// which tools exist, does --init-script inject the adapter, does evaluate return the snapshot,
// does a coordinate click on a snapshot pixel open the right popup, is WebMCP picked up.
import { spawn } from 'node:child_process';

const args = process.argv.slice(2); // extra args for the MCP server, e.g. --caps=vision
const child = spawn('npx', ['@playwright/mcp', '--config', 'agent/playwright-mcp.config.json', '--init-script', 'dist/inpage.js', ...args], {
  stdio: ['pipe', 'pipe', 'inherit'],
});
let buf = '';
let nextId = 1;
const pending = new Map();
child.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});
const rpc = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
const call = async (name, a) => {
  const r = await rpc('tools/call', { name, arguments: a });
  return (r.result?.content ?? []).map((c) => c.text ?? `[${c.type}]`).join('\n') || JSON.stringify(r.error ?? r.result);
};
const head = (s, n = 1500) => (s.length > n ? s.slice(0, n) + `\n… [${s.length - n} more chars]` : s);

await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'geowright-probe', version: '0' } });
notify('notifications/initialized', {});
const tools = (await rpc('tools/list', {})).result.tools.map((t) => t.name);
console.log('TOOLS:', tools.join(' '));

console.log('\n=== navigate (the accessibility snapshot an agent normally gets) ===');
console.log(head(await call('browser_navigate', { url: 'http://localhost:4173/' }), 2500));

console.log('\n=== tools after navigation (WebMCP page tools would appear here) ===');
const after = (await rpc('tools/list', {})).result.tools.map((t) => t.name);
console.log('new tools:', after.filter((t) => !tools.includes(t)).join(' ') || '(none)');
console.log('navigator.modelContext:', await call('browser_evaluate', { function: '() => typeof navigator.modelContext' }));

console.log('\n=== browser_evaluate -> map snapshot ===');
const snap = await call('browser_evaluate', { function: "async () => { await window.__geowright.waitForIdle('main', 5000); return await window.__geowright.snapshot('main'); }" });
console.log(head(snap, 3000));

if (after.includes('browser_mouse_click_xy')) {
  const m = snap.match(/#1 Point @\((\d+),(\d+)\)[^\n]*severity=\\?"high/);
  console.log('\n=== coordinate click on the high-severity alert at', m?.[1], m?.[2], '===');
  const res = await call('browser_mouse_click_xy', { element: 'high severity alert on the map', x: +m[1], y: +m[2] });
  console.log(head(res, 600));
  console.log('popup:', await call('browser_evaluate', { function: "() => document.querySelector('[data-testid=popup]')?.outerHTML ?? 'NO POPUP'" }));
}
child.kill();
process.exit(0);
