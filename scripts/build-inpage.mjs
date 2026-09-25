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

// README and DESIGN state the injected script's size. Keep them true: the build fails when either is off by more than 10%.
{
  const { readFileSync } = await import('node:fs');
  const { gzipSync } = await import('node:zlib');
  const js = readFileSync(join(root, 'dist/inpage.js'));
  const actual = { raw: js.length / 1000, gzipped: gzipSync(js).length / 1000 };
  const claims = [
    ['README.md', /injected script is about (\d+) KB, not minified \((\d+) KB gzipped/],
    ['docs/DESIGN.md', /grew from roughly \d+ KB to about (\d+) KB \(not minified; (\d+) KB gzipped/],
  ];
  const off = [];
  for (const [file, re] of claims) {
    const m = readFileSync(join(root, file), 'utf8').match(re);
    if (!m) { off.push(`${file}: the size sentence (${re}) was not found`); continue; }
    for (const [said, is, what] of [[+m[1], actual.raw, 'not minified'], [+m[2], actual.gzipped, 'gzipped']]) {
      if (Math.abs(is - said) > said * 0.1) off.push(`${file} says ${said} KB ${what}; dist/inpage.js is ${Math.round(is)} KB`);
    }
  }
  if (off.length) {
    console.error(`the documented size of the injected script is out of date:\n  ${off.join('\n  ')}`);
    process.exit(1);
  }
}
