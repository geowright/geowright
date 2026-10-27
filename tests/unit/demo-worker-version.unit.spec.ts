import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The demo serves a committed copy of MapLibre's worker (demo/public/maplibre, written by demo/scripts/copy-worker.mjs).
 * A worker from another maplibre-gl than the installed one is a mismatched MapLibre whose map never goes idle: every
 * browser test would then wait out its idle timeout. This test says so in seconds instead.
 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

test('the committed demo MapLibre worker is from the installed maplibre-gl', () => {
  const installed = JSON.parse(readFileSync(join(ROOT, 'node_modules/maplibre-gl/package.json'), 'utf8')).version;
  const notices = readFileSync(join(ROOT, 'demo/public/maplibre/THIRD_PARTY_LICENSES.md'), 'utf8');
  const committed = /\bmaplibre-gl (\S+)'s prebuilt dist\b/.exec(notices)?.[1];
  expect(committed, 'demo/public/maplibre/THIRD_PARTY_LICENSES.md names no maplibre-gl version').toBeDefined();
  expect(committed, `the demo worker is maplibre-gl ${committed}, node_modules has ${installed}: run node demo/scripts/copy-worker.mjs`)
    .toBe(installed);
});
