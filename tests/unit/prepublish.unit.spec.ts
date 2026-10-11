import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * The first version is published by hand from a fresh clone of the public repository (a trusted publisher can only be
 * set up on a package that exists). npm leaves out a `files` entry that does not exist without a word, so `npm publish`
 * of a tree nobody built ships LICENSE, NOTICE, README.md, agent/MAP_SKILL.md and package.json: no code, under a
 * version number npm never lets anyone reuse. `prepublishOnly`, which npm runs before it packs any directory it
 * publishes (`--dry-run` too), refuses unless dist/ holds the three entry points. It checks and never builds: what goes
 * out is what was built and read in `npm pack --dry-run`. release.yml builds and packs, then publishes the tarball with
 * `--ignore-scripts`, so the check never runs there.
 */
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const ENTRIES = ['dist/index.js', 'dist/inpage.js', 'dist/cli.js'];

/** Runs package.json's prepublishOnly as npm runs it: `sh -c` in the package root. */
function prepublishOnly(dir: string) {
  const script: unknown = pkg.scripts?.prepublishOnly;
  expect(typeof script, 'package.json has a prepublishOnly script').toBe('string');
  return spawnSync('sh', ['-c', script as string], { cwd: dir, encoding: 'utf8' });
}

/** A package root holding only the given dist/ files. */
function tree(name: string, files: string[]): string {
  const dir = test.info().outputPath(name);
  mkdirSync(`${dir}/dist`, { recursive: true });
  for (const f of files) writeFileSync(`${dir}/${f}`, '// built\n');
  return dir;
}

test('npm publish of an unbuilt tree stops before anything is packed, and says which entry points are missing', () => {
  const r = prepublishOnly(tree('unbuilt', []));
  expect(r.status).toBe(1);
  for (const f of ENTRIES) expect(r.stderr).toContain(f);
  expect(r.stderr).toContain('npm run build');
});

test('a tree missing any one entry point is refused too, and only that one is named', () => {
  for (const missing of ENTRIES) {
    const r = prepublishOnly(tree(`without-${missing.replace(/\W/g, '-')}`, ENTRIES.filter((f) => f !== missing)));
    expect(r.status, missing).toBe(1);
    expect(r.stderr, missing).toContain(missing);
    for (const other of ENTRIES.filter((f) => f !== missing)) expect(r.stderr, missing).not.toContain(other);
  }
});

test('a built tree passes the check (control)', () => {
  const r = prepublishOnly(tree('built', ENTRIES));
  expect(r.stderr).toBe('');
  expect(r.status).toBe(0);
});

test('the three files checked are the ones package.json ships and points at', () => {
  expect(pkg.files).toEqual(expect.arrayContaining(ENTRIES));
  expect(pkg.exports['.'].default).toBe('./dist/index.js');
  expect(pkg.exports['./inpage.js']).toBe('./dist/inpage.js');
  expect(pkg.bin.geowright).toBe('./dist/cli.js');
});
