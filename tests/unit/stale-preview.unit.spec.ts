import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { stalePreview } from '../stale-preview';

/**
 * The stale-preview trap (AGENTS.md): a reused `vite preview` serves whatever demo/dist it was started on.
 * tests/global-setup.ts refuses the run when the served build is not this checkout's, or demo/ changed after it.
 */
const URL = 'http://localhost:4673';
const HTML = '<!doctype html><script type="module" src="/assets/main-abc123.js"></script>';

function tree(): string {
  const root = test.info().outputPath('tree');
  mkdirSync(join(root, 'demo/dist'), { recursive: true });
  mkdirSync(join(root, 'demo/src'), { recursive: true });
  mkdirSync(join(root, 'demo/node_modules/x'), { recursive: true });
  const at = (p: string, s: number) => utimesSync(join(root, p), s, s);
  writeFileSync(join(root, 'demo/src/main.ts'), 'export {};\n');
  writeFileSync(join(root, 'demo/index.html'), '<html></html>\n');
  writeFileSync(join(root, 'demo/dist/index.html'), HTML);
  writeFileSync(join(root, 'demo/node_modules/x/newer.js'), '');
  at('demo/src/main.ts', 1_000);
  at('demo/index.html', 1_000);
  at('demo/dist/index.html', 2_000);
  at('demo/node_modules/x/newer.js', 3_000); // not a demo source: ignored
  return root;
}

test('a server that serves this checkout\'s current build: fine', async () => {
  expect(await stalePreview(tree(), URL, async () => HTML)).toBeUndefined();
});

test('a demo source changed after the build: stale, naming the file', async () => {
  const root = tree();
  utimesSync(join(root, 'demo/src/main.ts'), 3_000, 3_000);
  expect(await stalePreview(root, URL, async () => HTML)).toBe('changed after demo/dist was built, so the reused preview serves stale code: demo/src/main.ts');
});

test('a server that serves another build (another checkout, an older build): refused', async () => {
  const other = HTML.replace('abc123', 'def456');
  expect(await stalePreview(tree(), URL, async () => other)).toBe(`the server on ${URL} does not serve this checkout's demo/dist/index.html: another checkout's build, or an older one`);
});

test('no build in this checkout, yet a server answers: refused', async () => {
  const root = tree();
  rmSync(join(root, 'demo/dist'), { recursive: true });
  expect(await stalePreview(root, URL, async () => HTML)).toContain('demo/dist/index.html does not exist');
});

/** A real server on one loopback address only, as `vite preview` listens in a Linux container: on ::1 alone. */
async function serveOn(host: string, body: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((_req, res) => res.end(body));
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, host, resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://localhost:${port}`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

for (const host of ['::1', '127.0.0.1']) {
  test(`a server that listens on ${host} only is reached through localhost, as the browser reaches it`, async () => {
    const server = await serveOn(host, HTML);
    try {
      expect(await stalePreview(tree(), server.url)).toBeUndefined();
    } finally {
      await server.close();
    }
  });
}

test('no answer: says so, with the error, instead of blaming another checkout', async () => {
  const server = await serveOn('127.0.0.1', HTML);
  await server.close(); // a port nothing listens on
  await expect(stalePreview(tree(), server.url)).rejects.toThrow(`no answer from ${server.url}/`);
});
