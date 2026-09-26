import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * wild/scripts/apps.mjs: every vendored app keeps an allowlisted license (decision 0020) and a pinned UPSTREAM.md
 * with its one hook line (0016), its dist/ ships the notices of what it bundles (0020), each MapLibre example's
 * committed patch is the hook and nothing else (0016), and the `new` scaffold refuses a license outside the
 * allowlist. No network.
 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = 'wild/scripts/apps.mjs';
const NOTICES = 'dist/THIRD_PARTY_LICENSES.md';

function run(root: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [join(root, SCRIPT), ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}

/**
 * The part of the tree `check` reads, copied from `from` (this checkout by default) into `name`: the script, each
 * app's sources (not its build output, apart from dist/THIRD_PARTY_LICENSES.md), the MapLibre examples with their
 * patches, the fixture records, the wild specs.
 */
function scratchTree(name = 'tree', from = ROOT): string {
  const dir = test.info().outputPath(name);
  const copy = (p: string) => { mkdirSync(dirname(join(dir, p)), { recursive: true }); cpSync(join(from, p), join(dir, p), { recursive: true }); };
  copy(SCRIPT);
  copy('wild/fixtures/SOURCES.md');
  copy('wild/fixtures/sources');
  for (const p of ['LICENSE.txt', 'examples', 'patches']) copy(`wild/maplibre-examples/${p}`);
  copy('tests/wild');
  // Directories only: a stray file (Finder's .DS_Store) is not an app, as in apps.mjs.
  for (const app of readdirSync(join(from, 'wild/apps')).filter((n) => statSync(join(from, 'wild/apps', n)).isDirectory())) {
    for (const f of readdirSync(join(from, 'wild/apps', app))) if (f !== 'dist' && f !== 'node_modules') copy(`wild/apps/${app}/${f}`);
    if (existsSync(join(from, 'wild/apps', app, NOTICES))) copy(`wild/apps/${app}/${NOTICES}`);
  }
  return dir;
}

const HOOK = '(window.__geowright_maps ??= {}).main = map;';
/** A minimal vendored app in `tree`: its one source file holds the hook, UPSTREAM.md shows it and marks the file. */
function plantApp(tree: string, { license = true, spec = true } = {}): string {
  const planted = join(tree, 'wild/apps/planted');
  mkdirSync(join(planted, 'src'), { recursive: true });
  writeFileSync(join(planted, 'UPSTREAM.md'), [
    '- Repository: https://github.com/example/planted',
    `- Pinned commit: \`${SHA}\``,
    '',
    '```',
    'wild/apps/planted/src/app.js <- src/app.js (+1 line)',
    'wild/apps/planted/src/util.js <- src/util.js (byte-identical)',
    '```',
    '',
    '```diff',
    ' const map = new maplibregl.Map({});',
    `+${HOOK}`,
    '```',
    '',
  ].join('\n'));
  writeFileSync(join(planted, 'src/app.js'), `const map = new maplibregl.Map({});\n${HOOK}\nmap.on('load', () => {});\n`);
  writeFileSync(join(planted, 'src/util.js'), 'export const noop = () => {};\n');
  if (license) writeFileSync(join(planted, 'LICENSE'), MIT);
  mkdirSync(join(planted, 'dist'), { recursive: true });
  writeFileSync(join(planted, NOTICES), `# Licenses\n\n## example-lib - 1.0.0 (MIT)\n\n${MIT}`);
  if (spec) writeFileSync(join(tree, 'tests/wild/planted.spec.ts'), `// opens '/apps/planted/'\n`);
  return planted;
}

const MIT = `MIT License

Copyright (c) 2026 Example Author

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
`;
const SHA = 'a'.repeat(40);

test('check passes on the apps in this tree', () => {
  const r = run(ROOT, 'check');
  expect(r.out).toContain('wild apps: licenses on the allowlist');
  expect(r.code).toBe(0);
});

test('a stray file in wild/apps (a Finder .DS_Store) is not an app: the scratch copy and check both skip it', () => {
  const checkout = scratchTree('checkout');
  writeFileSync(join(checkout, 'wild/apps/.DS_Store'), 'Bud1: Finder metadata, not an app\n');
  expect(run(checkout, 'check').code, 'check on a tree with the stray file').toBe(0);
  const tree = scratchTree('tree', checkout);
  expect(run(tree, 'check').code, 'check on a scratch copy of that tree').toBe(0);
});

test('check fails when a wild app has no LICENSE, or one outside the allowlist', () => {
  const tree = scratchTree();
  expect(run(tree, 'check').code, 'the copied tree passes before anything is planted').toBe(0);

  const planted = plantApp(tree, { license: false });
  let r = run(tree, 'check');
  expect(r.code).toBe(1);
  expect(r.out).toContain('wild/apps/planted/: no LICENSE file');

  writeFileSync(join(planted, 'LICENSE'), 'GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007\n');
  r = run(tree, 'check');
  expect(r.code).toBe(1);
  expect(r.out).toContain('wild/apps/planted/LICENSE: not on the allowlist');
  expect(r.out).toContain('GPL');

  writeFileSync(join(planted, 'LICENSE'), MIT);
  expect(run(tree, 'check').code, 'an MIT license, a pinned commit, the hook, a spec and dist notices: passes').toBe(0);

  rmSync(join(tree, 'tests/wild/planted.spec.ts'));
  writeFileSync(join(planted, 'UPSTREAM.md'), '- Repository: https://github.com/example/planted\n- Pinned commit: main\n');
  r = run(tree, 'check');
  expect(r.out).toContain('wild/apps/planted/UPSTREAM.md: names no full upstream commit SHA');
  expect(r.out).toContain('wild/apps/planted/UPSTREAM.md: does not show the one added hook line');
  expect(r.out).toContain('wild/apps/planted/: no spec in tests/wild/ opens /apps/planted/');
});

test('check fails when an app\'s dist/ ships no notices, or a notice without its license text', () => {
  const tree = scratchTree();
  const planted = plantApp(tree);
  rmSync(join(planted, NOTICES));

  let r = run(tree, 'check');
  expect(r.code).toBe(1);
  expect(r.out).toContain(`wild/apps/planted/${NOTICES}: missing`);

  writeFileSync(join(planted, NOTICES), `# Licenses\n\n## example-lib - 1.0.0 (MIT)\n\n${MIT}\n## other-lib - 2.0.0 (ISC)\n`);
  r = run(tree, 'check');
  expect(r.code).toBe(1);
  expect(r.out).toContain(`wild/apps/planted/${NOTICES}: "other-lib - 2.0.0 (ISC)" has no license text`);

  writeFileSync(join(planted, NOTICES), '# Licenses\n\nThe app does not bundle any dependencies with licenses.\n');
  r = run(tree, 'check');
  expect(r.code).toBe(1);
  expect(r.out).toContain(`wild/apps/planted/${NOTICES}: lists no package`);

  writeFileSync(join(planted, NOTICES), `# Licenses\n\n## example-lib - 1.0.0 (MIT)\n\n${MIT}\n## other-lib - 2.0.0 (MIT)\n\n${MIT}`);
  expect(run(tree, 'check').code, 'every package with its text: passes').toBe(0);
});

test('check fails when an app\'s notices list maplibre-gl but not the packages MapLibre\'s dist bundles inside itself', () => {
  const tree = scratchTree();
  const planted = plantApp(tree);
  // A real app's notices, as its build writes them (maplibreNotices), then as Vite alone writes them (no source-map expansion).
  const real = readFileSync(join(ROOT, 'wild/apps/react-map-gl', NOTICES), 'utf8');
  writeFileSync(join(planted, NOTICES), real);
  expect(run(tree, 'check').code, 'maplibre-gl with the packages its dist bundles: passes').toBe(0);

  const viteOnly = real.split(/^(?=## )/m).filter((s) => !/^## .*, bundled in maplibre-gl /.test(s)).join('');
  expect(viteOnly).toContain('## maplibre-gl - ');
  writeFileSync(join(planted, NOTICES), viteOnly);
  let r = run(tree, 'check');
  expect(r.code).toBe(1);
  expect(r.out).toContain(`wild/apps/planted/${NOTICES}: lists maplibre-gl but not what its dist bundles (`);
  expect(r.out).toContain('earcut');

  writeFileSync(join(planted, NOTICES), real.replace(/^## earcut - [^\n]*\n[\s\S]*?(?=^## )/m, ''));
  r = run(tree, 'check');
  expect(r.code, 'one bundled package missing').toBe(1);
  expect(r.out).toContain('bundles (earcut)');
});

// the one-line rule (decision 0016) as far as it can be checked offline. Each planted edit below passed the old
// checks: examples.sh counted `^+[^+]` / `^-[^-]` (so a blank line, `--x` or `++y` was not counted, and any one added
// line passed), and apps.mjs read only UPSTREAM.md, never the app's sources.
const EXAMPLE = '3d-terrain';
const plantPatch = (tree: string, edit: (lines: string[], hook: number) => void) => {
  const p = join(tree, `wild/maplibre-examples/patches/${EXAMPLE}.diff`);
  const lines = readFileSync(p, 'utf8').split('\n');
  edit(lines, lines.findIndex((l) => l.startsWith('+') && l.includes('__geowright_maps')));
  writeFileSync(p, lines.join('\n'));
};

test('check and `patches` pass on the committed example patches, and name each count', () => {
  const r = run(ROOT, 'patches');
  expect(r.code, r.out).toBe(0);
  expect(r.out).toContain(`${EXAMPLE}: +1 -0`);
  expect(r.out.match(/: \+1 -0$/gm)?.length, 'one line per vendored example').toBe(readdirSync(join(ROOT, 'wild/maplibre-examples/examples')).length);
});

for (const [what, edit, says] of [
  ['an extra edit beyond the hook', (l: string[], h: number) => l.splice(h + 1, 0, '+    map.setZoom(3);'), '+2 -0'],
  ['an added blank line', (l: string[], h: number) => l.splice(h + 1, 0, '+'), 'added line "" is not the hook'],
  ['a removed blank line', (l: string[], h: number) => l.splice(h + 1, 0, '-'), '+1 -1'],
  ['a removed line whose content starts with --', (l: string[], h: number) => l.splice(h + 1, 0, '---x;'), '+1 -1'],
  ['an added line whose content starts with + (instead of the hook)', (l: string[], h: number) => l.splice(h, 1, '++y;'), 'added line "+y;" is not the hook'],
  ['one added line that is not the hook', (l: string[], h: number) => l.splice(h, 1, '+    window.leak = map;'), 'added line "    window.leak = map;" is not the hook'],
  ['the hook plus code on the same line', (l: string[], h: number) => l.splice(h, 1, `+    ${HOOK} map.setZoom(3);`), 'is not the hook'],
] as const) {
  test(`check fails on an example patch with ${what}`, () => {
    const tree = scratchTree();
    plantPatch(tree, edit);
    for (const cmd of ['check', 'patches']) {
      const r = run(tree, cmd);
      expect(r.code, `${cmd}: ${r.out}`).toBe(1);
      expect(r.out).toContain(`wild/maplibre-examples/patches/${EXAMPLE}.diff: `);
      expect(r.out).toContain(says);
    }
  });
}

test('check fails when an example and its patch disagree, or one has no other', () => {
  let tree = scratchTree();
  const html = join(tree, `wild/maplibre-examples/examples/${EXAMPLE}.html`);
  writeFileSync(html, readFileSync(html, 'utf8').replace(HOOK, `${HOOK}\n    ${HOOK}`));
  let r = run(tree, 'check');
  expect(r.code).toBe(1);
  expect(r.out).toContain(`wild/maplibre-examples/examples/${EXAMPLE}.html: 2 lines name __geowright_maps; the patch shows one`);

  tree = scratchTree('moved');
  const moved = join(tree, `wild/maplibre-examples/examples/${EXAMPLE}.html`);
  writeFileSync(moved, '<!-- an edit above the hook shifts it by a line -->\n' + readFileSync(moved, 'utf8'));
  r = run(tree, 'check');
  expect(r.code).toBe(1);
  expect(r.out).toMatch(new RegExp(`patches/${EXAMPLE}\\.diff: its added line is not line \\d+ of examples/${EXAMPLE}\\.html`));

  tree = scratchTree('unpatched');
  rmSync(join(tree, `wild/maplibre-examples/patches/${EXAMPLE}.diff`));
  r = run(tree, 'check');
  expect(r.code).toBe(1);
  expect(r.out).toContain(`wild/maplibre-examples/examples/${EXAMPLE}.html: no patches/${EXAMPLE}.diff`);
});

test('check fails when a wrapper app\'s sources hold more than the one recorded hook line', () => {
  const tree = scratchTree();
  const planted = plantApp(tree);
  expect(run(tree, 'check').code, 'the planted app, as recorded: passes').toBe(0);
  const app = join(planted, 'src/app.js');
  const clean = readFileSync(app, 'utf8');

  const cases: [string, () => void, string][] = [
    ['a second hook line in the same file', () => writeFileSync(app, clean + `${HOOK}\n`), 'wild/apps/planted/src/app.js: 2 lines name __geowright_maps'],
    ['a hook line UPSTREAM.md does not show', () => writeFileSync(app, clean.replace(HOOK, '(window.__geowright_maps ??= {}).main = map; map.setZoom(3);')), 'wild/apps/planted/src/app.js:2: the hook line is not the one wild/apps/planted/UPSTREAM.md shows'],
    ['another use of the global', () => writeFileSync(app, clean.replace(HOOK, 'window.__geowright_maps = { main: map };')), 'wild/apps/planted/src/app.js:2: names __geowright_maps but is not the hook line'],
    ['a hook in a file recorded as byte-identical', () => writeFileSync(join(planted, 'src/util.js'), `${HOOK}\n`), 'wild/apps/planted/src/util.js: holds the hook, but wild/apps/planted/UPSTREAM.md does not mark it "(+1 line)"'],
    ['a hook in an unrecorded file', () => writeFileSync(join(planted, 'main.js'), `${HOOK}\n`), 'wild/apps/planted/main.js: holds the hook, but wild/apps/planted/UPSTREAM.md does not mark it'],
    ['no hook where UPSTREAM.md marks "+1 line"', () => writeFileSync(app, clean.replace(`${HOOK}\n`, '')), 'wild/apps/planted/src/app.js: marked "(+1 line)" in UPSTREAM.md, but holds no hook line'],
  ];
  for (const [what, plant, says] of cases) {
    plant();
    const r = run(tree, 'check');
    expect(r.code, what).toBe(1);
    expect(r.out, what).toContain(says);
    writeFileSync(app, clean);
    rmSync(join(planted, 'main.js'), { force: true });
    writeFileSync(join(planted, 'src/util.js'), 'export const noop = () => {};\n');
  }
  expect(run(tree, 'check').code, 'restored: passes').toBe(0);
  // build output is not source: a bundle that inlines the hook (as every dist/ does) is not a second line
  writeFileSync(join(planted, 'dist/index.js'), `${HOOK}\n${HOOK}\n`);
  expect(run(tree, 'check').code, 'dist/ is not scanned').toBe(0);
});

test('check fails when a file under wild/fixtures has no row in SOURCES.md or a sources/*.md record', () => {
  const tree = scratchTree();
  writeFileSync(join(tree, 'wild/fixtures/planted.geojson'), '{"type":"FeatureCollection","features":[]}');
  const r = run(tree, 'check');
  expect(r.code).toBe(1);
  expect(r.out).toContain('wild/fixtures/planted.geojson: not named in wild/fixtures/SOURCES.md');

  writeFileSync(join(tree, 'wild/fixtures/sources/planted.md'), '| `planted.geojson` | synthetic | first-party |\n');
  expect(run(tree, 'check').code, 'named in a sources/*.md record: passes').toBe(0);
});

test('a directory a fixture record names covers the data under it, not code: a script there needs its own row', () => {
  const tree = scratchTree();
  mkdirSync(join(tree, 'wild/fixtures/demotiles/tiles/0/0'), { recursive: true });
  writeFileSync(join(tree, 'wild/fixtures/demotiles/tiles/0/0/0.pbf'), '');
  expect(run(tree, 'check').code, 'a tile under the recorded demotiles/ directory: passes').toBe(0);

  writeFileSync(join(tree, 'wild/fixtures/demotiles/planted.min.js'), '!function(){}();\n');
  const r = run(tree, 'check');
  expect(r.code).toBe(1);
  expect(r.out).toContain('wild/fixtures/demotiles/planted.min.js: code, and not named by its path in wild/fixtures/SOURCES.md');

  writeFileSync(join(tree, 'wild/fixtures/sources/planted.md'), '| `demotiles/planted.min.js` | synthetic | first-party |\n');
  expect(run(tree, 'check').code, 'named by its path: passes').toBe(0);
});

test('a fixture is recorded by its own path: a file name, or the tail of another path, that a record mentions is not enough', () => {
  const tree = scratchTree();
  mkdirSync(join(tree, 'wild/fixtures/newapp'), { recursive: true });
  // Both names appear in the records, for other files: vendor/turf@7/turf.min.js and demotiles/style.json.
  writeFileSync(join(tree, 'wild/fixtures/newapp/turf.min.js'), '!function(){}();\n');
  writeFileSync(join(tree, 'wild/fixtures/newapp/style.json'), '{"version":8,"sources":{},"layers":[]}');
  mkdirSync(join(tree, 'wild/fixtures/turf@7'), { recursive: true });
  writeFileSync(join(tree, 'wild/fixtures/turf@7/turf.min.js'), '!function(){}();\n'); // the tail of vendor/turf@7/…
  const r = run(tree, 'check');
  expect(r.code).toBe(1);
  expect(r.out).toContain('wild/fixtures/newapp/turf.min.js: code, and not named by its path');
  expect(r.out).toContain('wild/fixtures/newapp/style.json: not named in wild/fixtures/SOURCES.md');
  expect(r.out).toContain('wild/fixtures/turf@7/turf.min.js: code, and not named by its path');

  writeFileSync(join(tree, 'wild/fixtures/sources/planted.md'),
    '| `newapp/turf.min.js`, `newapp/style.json` | synthetic | first-party |\n| `turf@7/turf.min.js` | synthetic | first-party |\n');
  expect(run(tree, 'check').code, 'each named by its path: passes').toBe(0);
});

test('every file under demo/public is named by its path in docs/THIRD_PARTY_NOTICES.md', () => {
  const tree = scratchTree();
  for (const p of ['demo/public', 'docs/THIRD_PARTY_NOTICES.md']) {
    mkdirSync(dirname(join(tree, p)), { recursive: true });
    cpSync(join(ROOT, p), join(tree, p), { recursive: true });
  }
  expect(run(tree, 'check').code, 'the committed demo/public: every file recorded').toBe(0);

  writeFileSync(join(tree, 'demo/public/maplibre/planted.mjs'), 'export {};\n');
  const r = run(tree, 'check');
  expect(r.code).toBe(1);
  expect(r.out).toContain('demo/public/maplibre/planted.mjs: not named by its path in docs/THIRD_PARTY_NOTICES.md');

  writeFileSync(join(tree, 'docs/THIRD_PARTY_NOTICES.md'), readFileSync(join(tree, 'docs/THIRD_PARTY_NOTICES.md'), 'utf8') + '\n`demo/public/maplibre/planted.mjs`: synthetic.\n');
  expect(run(tree, 'check').code, 'named by its path: passes').toBe(0);
});

test('check fails when a wild app has no row in the public inventories (THIRD_PARTY_NOTICES, wild/README)', () => {
  const tree = scratchTree();
  for (const p of ['docs/THIRD_PARTY_NOTICES.md', 'wild/README.md']) {
    mkdirSync(dirname(join(tree, p)), { recursive: true });
    cpSync(join(ROOT, p), join(tree, p));
  }
  expect(run(tree, 'check').code, 'the committed apps: a row each').toBe(0);

  plantApp(tree);
  const r = run(tree, 'check');
  expect(r.code).toBe(1);
  expect(r.out).toContain("wild/apps/planted/: no row in docs/THIRD_PARTY_NOTICES.md's table");
  expect(r.out).toContain("wild/apps/planted/: no row in wild/README.md's table");

  const add = (p: string, row: string) => writeFileSync(join(tree, p), readFileSync(join(tree, p), 'utf8').replace(/^(\| `(wild\/)?apps\/pmtiles\/` \|.*\n)/m, `$1${row}\n`));
  add('docs/THIRD_PARTY_NOTICES.md', '| `wild/apps/planted/` | example/planted, MIT | `wild/apps/planted/LICENSE` |');
  expect(run(tree, 'check').out).not.toContain('THIRD_PARTY_NOTICES');
  add('wild/README.md', '| `apps/planted/` | a planted app | MIT | `/apps/planted/` |');
  expect(run(tree, 'check').code, 'a row in both: passes').toBe(0);
});

test('check fails on a vendored build under wild/fixtures/vendor/ without its license and its notices beside it', () => {
  const tree = scratchTree();
  const vendor = join(tree, 'wild/fixtures/vendor/planted@1');
  mkdirSync(vendor, { recursive: true });
  writeFileSync(join(vendor, 'planted.min.js'), '!function(){}();\n');
  writeFileSync(join(tree, 'wild/fixtures/sources/planted.md'), '| `vendor/planted@1/planted.min.js` | a CDN URL | MIT |\n');
  const r = run(tree, 'check');
  expect(r.code).toBe(1);
  expect(r.out).toContain('wild/fixtures/vendor/planted@1/: no license file');
  expect(r.out).toContain('wild/fixtures/vendor/planted@1/: no THIRD_PARTY_LICENSES.md');

  writeFileSync(join(vendor, 'LICENSE'), MIT);
  writeFileSync(join(vendor, 'THIRD_PARTY_LICENSES.md'), '# Licenses\n\n`planted.min.js` bundles nothing but its own code.\n');
  expect(run(tree, 'check').code, 'license and notices beside it: passes').toBe(0);
});

test('new scaffolds an MIT app: license byte-identical, UPSTREAM.md, fixture record, SOURCES.md row, spec; check then lists the TODOs', () => {
  const tree = scratchTree();
  const license = test.info().outputPath('upstream/LICENSE');
  mkdirSync(dirname(license), { recursive: true });
  writeFileSync(license, MIT);
  const sourcesBefore = readFileSync(join(tree, 'wild/fixtures/SOURCES.md'), 'utf8');

  const r = run(tree, 'new', 'fake-app', 'https://github.com/example/fake-app', SHA, license);
  expect(r.out).toContain('license: MIT (LICENSE) — on the allowlist');
  expect(r.code).toBe(0);
  expect(readFileSync(join(tree, 'wild/apps/fake-app/LICENSE'), 'utf8')).toBe(MIT);
  const upstream = readFileSync(join(tree, 'wild/apps/fake-app/UPSTREAM.md'), 'utf8');
  expect(upstream).toContain('- Repository: https://github.com/example/fake-app');
  expect(upstream).toContain(`- Pinned commit: \`${SHA}\``);
  expect(upstream).toContain('+(window.__geowright_maps ??= {}).main = map;');
  expect(readFileSync(join(tree, 'wild/fixtures/sources/fake-app.md'), 'utf8')).toContain('never OpenStreetMap-derived (ODbL), CC-BY');
  expect(readFileSync(join(tree, 'wild/fixtures/SOURCES.md'), 'utf8')).toBe(sourcesBefore + '| `sources/fake-app.md` | TODO(new-app): what the fake-app app fetches | TODO(new-app): the fixtures\' license |\n');
  const spec = readFileSync(join(tree, 'tests/wild/fake-app.spec.ts'), 'utf8');
  expect(spec).toContain(`from './harness'`);
  expect(spec).toContain(`wild.open('/apps/fake-app/', { routes })`);

  const again = run(tree, 'new', 'fake-app', 'https://github.com/example/fake-app', SHA, license);
  expect(again.code, 'never overwrites').toBe(1);
  expect(again.out).toContain('wild/apps/fake-app already exists');

  const c = run(tree, 'check');
  expect(c.code, 'the scaffold is a to-do list: check fails until it is filled in').toBe(1);
  for (const f of ['wild/apps/fake-app/UPSTREAM.md', 'wild/fixtures/SOURCES.md', 'wild/fixtures/sources/fake-app.md', 'tests/wild/fake-app.spec.ts']) {
    expect(c.out).toContain(`${f}: still has TODO(new-app) placeholders`);
  }

  // a tree with no wild/fixtures/sources/ or tests/wild/ yet: directories are created, nothing is half-written
  const bare = test.info().outputPath('bare');
  for (const p of [SCRIPT, 'wild/fixtures/SOURCES.md']) { mkdirSync(dirname(join(bare, p)), { recursive: true }); cpSync(join(ROOT, p), join(bare, p)); }
  expect(run(bare, 'new', 'fake-app', 'https://github.com/example/fake-app', SHA, license).code).toBe(0);
  expect(existsSync(join(bare, 'tests/wild/fake-app.spec.ts'))).toBe(true);
});

for (const [kind, text, named] of [
  ['GPL', 'GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007\n', 'GPL / LGPL / AGPL'],
  ['CC-BY', 'Attribution 4.0 International\n\nCreative Commons Attribution 4.0 International Public License\n', 'CC-BY'],
  ['MIT next to GPL (a dual license needs a person)', MIT + '\nAlternatively, under the GNU General Public License v2.\n', 'GPL'],
  ['an unrecognised text', 'Copyright 2026 Example. All rights reserved.\n', 'not one this script recognises'],
] as const) {
  test(`new refuses ${kind} and writes nothing`, () => {
    const tree = scratchTree();
    const license = test.info().outputPath('upstream/LICENSE');
    mkdirSync(dirname(license), { recursive: true });
    writeFileSync(license, text);
    const sourcesBefore = readFileSync(join(tree, 'wild/fixtures/SOURCES.md'), 'utf8');

    const r = run(tree, 'new', 'fake-app', 'https://github.com/example/fake-app', SHA, license);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`REFUSED: ${license}:`);
    expect(r.out).toContain(named);
    expect(r.out).toContain('Only MIT, BSD (0BSD too), ISC, Apache-2.0, CC0, Unlicense, EDL-1.0, the Unicode data license (and OFL for fonts) can be vendored');
    expect(r.out).toContain('Nothing was written.');
    expect(existsSync(join(tree, 'wild/apps/fake-app'))).toBe(false);
    expect(existsSync(join(tree, 'wild/fixtures/sources/fake-app.md'))).toBe(false);
    expect(existsSync(join(tree, 'tests/wild/fake-app.spec.ts'))).toBe(false);
    expect(readFileSync(join(tree, 'wild/fixtures/SOURCES.md'), 'utf8')).toBe(sourcesBefore);
  });
}

// Decision 0020 adds these two to the list; both texts are recognised by their own wording (0BSD's is ISC's grant without
// its notice condition, the Unicode data license's opens as MIT's does).
for (const [kind, text] of [
  ['0BSD (tslib)', 'Copyright (c) Microsoft Corporation.\n\nPermission to use, copy, modify, and/or distribute this software for any\npurpose with or without fee is hereby granted.\n\nTHE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES.\n'],
  ['the Unicode data license', 'UNICODE LICENSE V3\n\nCOPYRIGHT AND PERMISSION NOTICE\n\nCopyright © 1991-2024 Unicode, Inc.\n\nPermission is hereby granted, free of charge, to any person obtaining a\ncopy of data files and any associated documentation (the "Data Files") or\nsoftware and any associated documentation (the "Software") to deal in the\nData Files or Software without restriction.\n'],
] as const) {
  test(`new accepts ${kind} (decision 0020)`, () => {
    const tree = scratchTree();
    const license = test.info().outputPath('upstream/LICENSE');
    mkdirSync(dirname(license), { recursive: true });
    writeFileSync(license, text);
    const r = run(tree, 'new', 'fake-app', 'https://github.com/example/fake-app', SHA, license);
    expect(r.out).not.toContain('REFUSED');
    expect(existsSync(join(tree, 'wild/apps/fake-app/LICENSE'))).toBe(true);
  });
}

test('new refuses a branch name instead of a commit SHA, and a bad app name', () => {
  const tree = scratchTree();
  const r = run(tree, 'new', 'Fake App', 'https://github.com/example/fake-app', 'main', join(tree, SCRIPT));
  expect(r.code).toBe(1);
  expect(r.out).toContain('<name> must be lower-case letters, digits and dashes');
  expect(r.out).toContain('<commit> must be the full 40-character commit SHA');
});
