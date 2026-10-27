import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error: a plain .mjs build script, no typings
import { bundled, sections } from '../../scripts/maplibre-notices.mjs';

/**
 * scripts/maplibre-notices.mjs: what MapLibre's prebuilt dist bundles, read from its source maps (decision 0020). Code
 * MapLibre copied into its own source keeps its notice only in a comment; a source whose comment names a copyright or
 * where the code came from must be known to the script, or the build fails.
 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

type Bundled = { packages: { name: string }[]; copied: { file: string; name: string; license: string; text: string }[] };

/** A maplibre-gl directory whose one dist file's source map holds `sources` (path -> content). Packages: `pkgs`. */
function fakeMaplibre(sources: Record<string, string>, pkgs: string[] = []): string {
  const root = test.info().outputPath('tree');
  const dir = join(root, 'node_modules/maplibre-gl');
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'maplibre-gl', version: '0.0.0' }));
  writeFileSync(join(dir, 'dist/maplibre-gl.js'), '/* bundled */\n');
  const names = Object.keys(sources);
  for (const p of pkgs) {
    const pd = join(root, 'node_modules', p);
    mkdirSync(pd, { recursive: true });
    writeFileSync(join(pd, 'package.json'), JSON.stringify({ name: p, version: '1.0.0', license: 'BSD-3-Clause' }));
    writeFileSync(join(pd, 'LICENSE'), 'Copyright (c) 2014, Mapbox\n\nRedistribution and use in source and binary forms, with or without modification, are permitted.\n');
    names.push(`../node_modules/${p}/index.js`);
  }
  const map = { version: 3, sources: names, sourcesContent: names.map((n) => sources[n] ?? ''), mappings: '' };
  writeFileSync(join(dir, 'dist/maplibre-gl.js.map'), JSON.stringify(map));
  return dir;
}

test('the Wreck regex in MapLibre 6.10.0 util.ts ("Taken from [Wreck]") is listed with @hapi/wreck\'s BSD-3-Clause text', () => {
  const b = bundled(join(ROOT, 'node_modules/maplibre-gl')) as Bundled;
  const wreck = b.copied.find((c) => c.file === '/src/util/util.ts');
  expect(wreck, `copied: ${b.copied.map((c) => c.file).join(', ')}`).toBeDefined();
  expect(wreck!.license).toBe('BSD-3-Clause');
  expect(wreck!.text).toContain('Copyright (c) 2012-2014, Walmart.');
  expect(wreck!.text).toContain('Redistribution and use in source and binary forms');
});

for (const [kind, comment] of [
  ['a "Taken from [X](url)" note', '// Taken from [Foo](https://github.com/example/foo)\nexport const x = 1;\n'],
  ['a "Copied from https://…" note', '// Copied from https://github.com/example/foo/blob/abc/index.js\nexport const x = 1;\n'],
  ['a "Copyright <year>" line without "(c)"', '/* Copyright 2010 Example Person */\nexport const x = 1;\n'],
] as const) {
  test(`a MapLibre source with ${kind} that the script does not know fails the build`, () => {
    const dir = fakeMaplibre({ '../src/util/planted.ts': comment });
    expect(() => bundled(dir)).toThrow(/\/src\/util\/planted\.ts .*not in scripts\/maplibre-notices\.mjs/);
  });
}

test('prose that only says "taken from" or "copied from" something in MapLibre itself is not a notice', () => {
  const dir = fakeMaplibre({
    '../src/render/planted.ts': '/** The name is generated rather than taken from the style. The image will be copied from the canvas. */\n',
  });
  expect((bundled(dir) as Bundled).copied).toEqual([]);
});

test('code copied from vector-tile-js is covered by the @mapbox/vector-tile text, which must then be bundled too', () => {
  const copied = { '../src/util/vectortile_to_geojson.ts': '// Copied from https://github.com/mapbox/vector-tile-js/blob/f1457ee/index.js\n' };
  expect(() => bundled(fakeMaplibre(copied))).toThrow(/vectortile_to_geojson\.ts.*@mapbox\/vector-tile.*not bundled/);
  const b = bundled(fakeMaplibre(copied, ['@mapbox/vector-tile'])) as Bundled;
  expect(b.packages.map((p) => p.name)).toContain('@mapbox/vector-tile');
  expect(b.copied).toEqual([]);
});

test('a 0-byte dist file without a source map (6.15\'s shared chunk) has no notices; a file with code but no map fails', () => {
  const dir = fakeMaplibre({}, ['@mapbox/point-geometry']);
  writeFileSync(join(dir, 'dist/maplibre-gl-shared.mjs'), '');
  const b = bundled(dir, ['maplibre-gl.js', 'maplibre-gl-shared.mjs']) as Bundled;
  expect(b.packages.map((p) => p.name)).toEqual(['@mapbox/point-geometry']);
  writeFileSync(join(dir, 'dist/maplibre-gl-shared.mjs'), 'export const x = 1;\n');
  expect(() => bundled(dir, ['maplibre-gl.js', 'maplibre-gl-shared.mjs'])).toThrow(/ENOENT.*maplibre-gl-shared\.mjs\.map/);
});

// The heading says which option of a choice is used (decision 0020); wild/scripts/apps.mjs check accepts the other
// options' texts below on that word. A license that is a choice AND something else is not a choice: no election.
test('a package\'s heading names the option used only when its license is a choice of licenses and nothing else', () => {
  const pkg = (license: string) => ({ name: 'some-pkg', version: '1.0.0', license, text: 'TEXT' });
  const heads = (sections({ packages: ['(MIT OR Apache-2.0)', '(MIT OR Apache-2.0) AND CC-BY-4.0', 'MIT OR (Apache-2.0 AND CC-BY-4.0)'].map(pkg), copied: [] }, 'bundled in maplibre-gl 6.10.0') as string[])
    .map((s) => s.split('\n')[0]);
  expect(heads).toEqual([
    '## some-pkg - 1.0.0 ((MIT OR Apache-2.0)), used under MIT (the file below carries every option\'s text), bundled in maplibre-gl 6.10.0',
    '## some-pkg - 1.0.0 ((MIT OR Apache-2.0) AND CC-BY-4.0), bundled in maplibre-gl 6.10.0',
    '## some-pkg - 1.0.0 (MIT OR (Apache-2.0 AND CC-BY-4.0)), bundled in maplibre-gl 6.10.0',
  ]);
});
