import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stalePreview } from '../stale-preview';

/**
 * The stale-preview trap (AGENTS.md, D10 of an earlier issue): a reused `vite preview` serves whatever demo/dist it was started on.
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
