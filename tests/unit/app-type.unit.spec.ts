import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

/**
 * `geowright/app`: the hook line compiles in an app's TypeScript with one reference line, and the entry is type-only.
 *
 * A scratch app with ITS OWN tsconfig (no tests in it, nothing imports 'geowright'), and geowright "installed" in its
 * node_modules the way npm would lay it out: the real package.json (its `exports`) and the typings emitted by the real
 * build config (tsconfig.build.json). The app file holds the exact hook line next to a real maplibre-gl Map.
 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TSC = join(ROOT, 'node_modules/typescript/bin/tsc');
const HOOK = '(window.__geowright_maps ??= {}).main = map;';
const REFERENCE = '/// <reference types="geowright/app" />';

async function tsc(...args: string[]): Promise<{ code: number; out: string }> {
  return promisify(execFile)(process.execPath, [TSC, '--pretty', 'false', ...args], { cwd: ROOT }).then(
    (r) => ({ code: 0, out: `${r.stdout}${r.stderr}` }),
    (e: { code?: number; stdout?: string; stderr?: string; message: string }) => ({ code: e.code ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` || e.message }),
  );
}

/** geowright as installed in `<dir>/node_modules/geowright`, built from this checkout. */
async function install(dir: string): Promise<string> {
  const pkg = join(dir, 'node_modules/geowright');
  mkdirSync(pkg, { recursive: true });
  cpSync(join(ROOT, 'package.json'), join(pkg, 'package.json'));
  const built = await tsc('-p', join(ROOT, 'tsconfig.build.json'), '--outDir', join(pkg, 'dist/types'));
  expect(built.out, 'tsc -p tsconfig.build.json').toBe('');
  symlinkSync(join(ROOT, 'node_modules/maplibre-gl'), join(dir, 'node_modules/maplibre-gl'), 'dir');
  return pkg;
}

function app(dir: string, name: string, compilerOptions: Record<string, unknown>, withReference: boolean): string {
  const root = join(dir, name);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name, private: true, type: 'module' }));
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { target: 'ES2022', lib: ['ES2023', 'DOM'], strict: true, noEmit: true, skipLibCheck: true, types: [], ...compilerOptions }, include: ['src'] }),
  );
  writeFileSync(join(root, 'src/main.ts'), [`import { Map } from 'maplibre-gl';`, '', `const map = new Map({ container: 'map' });`, HOOK, ''].join('\n'));
  if (withReference) writeFileSync(join(root, 'src/env.d.ts'), `${REFERENCE}\n`);
  return root;
}

test('geowright/app: the exact hook line compiles with the reference line, and fails with TS2339 without it', async () => {
  const dir = test.info().outputPath('scratch');
  await install(dir);
  for (const [name, options] of [
    ['bundler', { module: 'ESNext', moduleResolution: 'Bundler' }], // Vite's template
    ['nodenext', { module: 'NodeNext', moduleResolution: 'NodeNext' }],
  ] as const) {
    const withRef = app(dir, `${name}-with`, options, true);
    expect(await tsc('-p', withRef), `${name}: with ${REFERENCE}`).toEqual({ code: 0, out: '' });

    const without = app(dir, `${name}-without`, options, false);
    const failed = await tsc('-p', without);
    expect(failed.code, `${name}: without the reference line`).not.toBe(0);
    expect(failed.out).toMatch(/src[/\\]main\.ts\(4,\d+\): error TS2339: Property '__geowright_maps' does not exist on type 'Window/);
  }
});

test('geowright/app is type-only: its export has a `types` condition and nothing else, and no JavaScript is built from it', async () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  expect(pkg.exports['./app']).toEqual({ types: './dist/types/app.d.ts' });
  expect(pkg.files).toContain('dist/types');

  const dir = test.info().outputPath('scratch');
  const installed = await install(dir);
  const types = join(installed, 'dist/types');
  expect(existsSync(join(types, 'app.d.ts'))).toBe(true);
  const dts = readFileSync(join(types, 'app.d.ts'), 'utf8');
  expect(dts).toContain('__geowright_maps?: Record<string, unknown>;');
  // declarations only: no `declare const/function/class` a bundler could be asked to resolve at run time
  expect(dts).not.toMatch(/\bdeclare\s+(const|let|var|function|class)\b/);
  // and no bundle is built from it: the esbuild entry points are the Playwright side and the CLI
  expect(pkg.scripts['build:node']).not.toMatch(/src\/app/);
});
