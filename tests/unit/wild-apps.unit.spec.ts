import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * wild/scripts/apps.mjs: every vendored app keeps an allowlisted license (decision 0008) and a pinned UPSTREAM.md
 * with its one hook line (0010), and the `new` scaffold refuses a license outside the allowlist. No network.
 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = 'wild/scripts/apps.mjs';

function run(root: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [join(root, SCRIPT), ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}

/** The part of the tree `check` reads, copied: the script, each app's license + UPSTREAM.md, the fixture records, the wild specs. */
function scratchTree(): string {
  const dir = test.info().outputPath('tree');
  const copy = (p: string) => { mkdirSync(dirname(join(dir, p)), { recursive: true }); cpSync(join(ROOT, p), join(dir, p), { recursive: true }); };
  copy(SCRIPT);
  copy('wild/fixtures/SOURCES.md');
  copy('wild/fixtures/sources');
  copy('wild/maplibre-examples/LICENSE.txt');
  copy('tests/wild');
  for (const app of readdirSync(join(ROOT, 'wild/apps'))) {
    for (const f of readdirSync(join(ROOT, 'wild/apps', app))) if (/^(licen[cs]e|copying)|^UPSTREAM\.md$/i.test(f)) copy(`wild/apps/${app}/${f}`);
  }
  return dir;
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

test('check fails when a wild app has no LICENSE, or one outside the allowlist', () => {
  const tree = scratchTree();
  expect(run(tree, 'check').code, 'the copied tree passes before anything is planted').toBe(0);

  const planted = join(tree, 'wild/apps/planted');
  mkdirSync(planted);
  writeFileSync(join(planted, 'UPSTREAM.md'), `- Repository: https://github.com/example/planted\n- Pinned commit: \`${SHA}\`\n\n+(window.__geowright_maps ??= {}).main = map;\n`);
  writeFileSync(join(tree, 'tests/wild/planted.spec.ts'), `// opens '/apps/planted/'\n`);
  let r = run(tree, 'check');
  expect(r.code).toBe(1);
  expect(r.out).toContain('wild/apps/planted/: no LICENSE file');

  writeFileSync(join(planted, 'LICENSE'), 'GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007\n');
  r = run(tree, 'check');
  expect(r.code).toBe(1);
  expect(r.out).toContain('wild/apps/planted/LICENSE: not on the allowlist');
  expect(r.out).toContain('GPL');

  writeFileSync(join(planted, 'LICENSE'), MIT);
  expect(run(tree, 'check').code, 'an MIT license, a pinned commit, the hook and a spec: passes').toBe(0);

  rmSync(join(tree, 'tests/wild/planted.spec.ts'));
  writeFileSync(join(planted, 'UPSTREAM.md'), '- Repository: https://github.com/example/planted\n- Pinned commit: main\n');
  r = run(tree, 'check');
  expect(r.out).toContain('wild/apps/planted/UPSTREAM.md: names no full upstream commit SHA');
  expect(r.out).toContain('wild/apps/planted/UPSTREAM.md: does not show the one added hook line');
  expect(r.out).toContain('wild/apps/planted/: no spec in tests/wild/ opens /apps/planted/');
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
    expect(r.out).toContain('Only MIT, BSD, ISC, Apache-2.0, CC0, Unlicense (and OFL for fonts) can be vendored');
    expect(r.out).toContain('Nothing was written.');
    expect(existsSync(join(tree, 'wild/apps/fake-app'))).toBe(false);
    expect(existsSync(join(tree, 'wild/fixtures/sources/fake-app.md'))).toBe(false);
    expect(existsSync(join(tree, 'tests/wild/fake-app.spec.ts'))).toBe(false);
    expect(readFileSync(join(tree, 'wild/fixtures/SOURCES.md'), 'utf8')).toBe(sourcesBefore);
  });
}

test('new refuses a branch name instead of a commit SHA, and a bad app name', () => {
  const tree = scratchTree();
  const r = run(tree, 'new', 'Fake App', 'https://github.com/example/fake-app', 'main', join(tree, SCRIPT));
  expect(r.code).toBe(1);
  expect(r.out).toContain('<name> must be lower-case letters, digits and dashes');
  expect(r.out).toContain('<commit> must be the full 40-character commit SHA');
});
