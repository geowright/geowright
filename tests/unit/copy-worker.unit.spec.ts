import { test, expect } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
// @ts-expect-error: a plain .mjs build script, no typings
import { copyWorker } from '../../demo/scripts/copy-worker.mjs';

/**
 * demo/scripts/copy-worker.mjs copies MapLibre's worker files into the demo. Since maplibre-gl 6.15 the worker is
 * self-contained and the shared chunk is a 0-byte file with no source map; a demo that kept serving an older shared
 * chunk beside it ran a mismatched MapLibre whose map never went idle.
 */

/** A maplibre-gl directory with the worker and a shared chunk; `shared`: its content, or '' (6.15: empty, no map). */
function fakeMaplibre(shared: string): string {
  const dir = join(test.info().outputPath('tree'), 'node_modules/maplibre-gl');
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'maplibre-gl', version: '9.9.9' }));
  writeFileSync(join(dir, 'LICENSE.txt'), 'Copyright (c) 2023, MapLibre contributors\n');
  const map = JSON.stringify({ version: 3, sources: ['../src/source/worker.ts'], sourcesContent: [''], mappings: '' });
  writeFileSync(join(dir, 'dist/maplibre-gl-worker.mjs'), 'self.onmessage = () => {};\n');
  writeFileSync(join(dir, 'dist/maplibre-gl-worker.mjs.map'), map);
  writeFileSync(join(dir, 'dist/maplibre-gl-shared.mjs'), shared);
  if (shared) writeFileSync(join(dir, 'dist/maplibre-gl-shared.mjs.map'), map);
  return dir;
}

test('a 6.15 dist (self-contained worker, 0-byte shared chunk without a map) copies the worker and drops a stale shared chunk', () => {
  const dest = test.info().outputPath('public');
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, 'maplibre-gl-shared.mjs'), '// a shared chunk from an older maplibre-gl\n');
  expect(copyWorker(fakeMaplibre(''), dest)).toEqual(['maplibre-gl-worker.mjs']);
  expect(readFileSync(join(dest, 'maplibre-gl-worker.mjs'), 'utf8')).toBe('self.onmessage = () => {};\n');
  expect(existsSync(join(dest, 'maplibre-gl-shared.mjs'))).toBe(false);
  expect(existsSync(join(dest, 'LICENSE.txt'))).toBe(true);
  expect(readFileSync(join(dest, 'THIRD_PARTY_LICENSES.md'), 'utf8')).toContain('`maplibre-gl-worker.mjs` is maplibre-gl 9.9.9\'s prebuilt dist');
});

test('a 0-byte shared chunk that still has a source map is not copied', () => {
  const dir = fakeMaplibre('');
  writeFileSync(join(dir, 'dist/maplibre-gl-shared.mjs.map'), readFileSync(join(dir, 'dist/maplibre-gl-worker.mjs.map')));
  const dest = test.info().outputPath('public');
  expect(copyWorker(dir, dest)).toEqual(['maplibre-gl-worker.mjs']);
  expect(existsSync(join(dest, 'maplibre-gl-shared.mjs'))).toBe(false);
});

test('a 6.10 dist (worker and shared chunk, each with its map) copies both', () => {
  const dest = test.info().outputPath('public');
  expect(copyWorker(fakeMaplibre('export const shared = 1;\n'), dest)).toEqual(['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs']);
  expect(readFileSync(join(dest, 'maplibre-gl-shared.mjs'), 'utf8')).toBe('export const shared = 1;\n');
  expect(readFileSync(join(dest, 'THIRD_PARTY_LICENSES.md'), 'utf8'))
    .toContain('`maplibre-gl-shared.mjs` and `maplibre-gl-worker.mjs` are maplibre-gl 9.9.9\'s prebuilt dist');
});
