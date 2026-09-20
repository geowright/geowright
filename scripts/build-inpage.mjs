#!/usr/bin/env node
// Builds the two scripts that are injected into the page under test, with a legal banner, and
// the license texts of what got bundled into them (scripts/third-party-licenses.mjs).
import { build } from 'esbuild';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const banner = '/*! geowright | Apache-2.0 | bundles third-party code: see THIRD_PARTY_LICENSES.txt next to this file */';
for (const [entry, out] of [['src/inpage/index.ts', 'dist/inpage.js'], ['src/inpage/agent-entry.ts', 'dist/inpage-agent.js']]) {
  await build({
    entryPoints: [join(root, entry)], outfile: join(root, out),
    bundle: true, format: 'iife', target: 'es2022', banner: { js: banner }, legalComments: 'inline',
  });
}
await import('./third-party-licenses.mjs');
