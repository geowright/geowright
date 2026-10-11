import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * scripts/failed-test-results.mjs packs the output of the FAILED tests of a run, and nothing else, into one archive:
 * the failure artifact of a 20x run cannot be the whole tree (960,000 files: the upload ran out of memory, twice).
 */
const SCRIPT = fileURLToPath(new URL('../../scripts/failed-test-results.mjs', import.meta.url));

function tree(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(`${root}/${path}`.replace(/\/[^/]+$/, ''), { recursive: true });
    writeFileSync(`${root}/${path}`, content);
  }
}

/**
 * Runs `body` in a scratch directory under the system temp directory and removes it. Not test.info().outputPath():
 * Playwright keeps a passed test's output directory, so these fixture trees (marker files, .last-run.json) would sit in
 * the very test-results/ tree the packer packs when the suite fails.
 */
function inScratch(prefix: string, body: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const members = (archive: string): string[] =>
  execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map((m) => m.replace(/^\.\//, '')).sort();

test('keeps every file of a failed test but its node_modules, every .last-run.json, and nothing of a passed test', () => {
  inScratch('failed-test-results-', (base) => {
    const results = join(base, 'results');
    tree(results, {
      '.last-run.json': '{"status":"failed","failedTests":["a","b"]}',
      // a failed e2e test: a trace and a screenshot
      'wild-a-failed-chromium/trace.zip': 'zip',
      'wild-a-failed-chromium/test-failed-1.png': 'png',
      // a failed unit test that copied a package tree (with node_modules) into its output directory
      'unit-b-failed-chromium/error-context.md': 'md',
      'unit-b-failed-chromium/tree/package.json': '{}',
      'unit-b-failed-chromium/tree/node_modules/dep/index.js': 'x',
      // a passed test's leftovers: no marker
      'unit-c-passed-chromium/scratch/node_modules/dep/index.js': 'x',
      'unit-c-passed-chromium/scratch/package.json': '{}',
      // the compat config writes under its own directory, with its own .last-run.json
      'compat/.last-run.json': '{"status":"failed","failedTests":["d"]}',
      'compat/d-failed-chromium/trace.zip': 'zip',
      'compat/e-passed-chromium/out.txt': 'x',
    });
    const out = join(base, 'failed.tgz');
    const stdout = execFileSync(process.execPath, [SCRIPT, '--results', results, '--out', out], { encoding: 'utf8' });
    expect(stdout).toContain('3 failed test directories');
    expect(stdout).toContain('1 node_modules tree(s) left out');
    expect(members(out)).toEqual([
      '.last-run.json',
      'compat/.last-run.json',
      'compat/d-failed-chromium/trace.zip',
      'unit-b-failed-chromium/error-context.md',
      'unit-b-failed-chromium/tree/package.json',
      'wild-a-failed-chromium/test-failed-1.png',
      'wild-a-failed-chromium/trace.zip',
    ]);
  });
});

test('a run with no failed test (or no results directory at all) still writes an archive', () => {
  inScratch('failed-test-results-none-', (base) => {
    const results = join(base, 'none');
    tree(results, { '.last-run.json': '{"status":"passed","failedTests":[]}', 'unit-c-passed-chromium/out.txt': 'x' });
    const out = join(base, 'none.tgz');
    expect(execFileSync(process.execPath, [SCRIPT, '--results', results, '--out', out], { encoding: 'utf8' })).toContain('0 failed test directories');
    expect(members(out)).toEqual(['.last-run.json']);
    const missing = join(base, 'missing.tgz');
    expect(execFileSync(process.execPath, [SCRIPT, '--results', join(base, 'does-not-exist'), '--out', missing], { encoding: 'utf8' })).toContain('0 failed test directories');
    expect(members(missing)).toEqual([]);
  });
});

test('runs from a checkout whose path has a space or a non-ASCII letter, or is reached through a symlink', () => {
  // The script decides it was run (not imported) by comparing its own module URL with the path it was started by. A URL
  // percent-encodes a space ("%20") and "é", and names the real path where a symlink was followed: a raw string comparison
  // missed, and the script wrote nothing and exited 0, so the CI upload step found no file and only warned.
  inScratch('failed-test-results-paths-', (base) => {
    const checkout = (dir: string): string => {
      mkdirSync(join(dir, 'scripts'), { recursive: true });
      copyFileSync(SCRIPT, join(dir, 'scripts', 'failed-test-results.mjs'));
      tree(dir, { 'test-results/t1-failed-chromium/error-context.md': 'md' });
      return dir;
    };
    const space = checkout(join(base, 'a checkout'));
    const accent = checkout(join(base, 'café'));
    checkout(join(base, 'real'));
    symlinkSync(join(base, 'real'), join(base, 'link'));
    const link = join(base, 'link');
    const runs: Array<[string, string]> = [
      [space, 'scripts/failed-test-results.mjs'], // the form the CI workflows use
      [space, join(space, 'scripts', 'failed-test-results.mjs')],
      [accent, join(accent, 'scripts', 'failed-test-results.mjs')],
      [link, join(link, 'scripts', 'failed-test-results.mjs')],
    ];
    for (const [cwd, script] of runs) {
      const out = join(cwd, 'test-results-failed.tgz');
      rmSync(out, { force: true });
      const run = `node ${script} in ${cwd}`;
      expect.soft(execFileSync(process.execPath, [script], { cwd, encoding: 'utf8' }), run).toContain('1 failed test directory');
      expect.soft(existsSync(out) ? members(out) : 'no archive', run).toEqual(['t1-failed-chromium/error-context.md']);
    }
    // Imported by another module, it packs nothing.
    writeFileSync(join(space, 'importer.mjs'), "import { pack } from './scripts/failed-test-results.mjs';\nconsole.log(typeof pack);\n");
    rmSync(join(space, 'test-results-failed.tgz'), { force: true });
    expect(execFileSync(process.execPath, ['importer.mjs'], { cwd: space, encoding: 'utf8' }).trim()).toBe('function');
    expect(existsSync(join(space, 'test-results-failed.tgz'))).toBe(false);
  });
});

test('only the run\'s own test directories are failed tests: nothing from inside a passed test\'s directory', () => {
  // Playwright gives each test one directory directly under the run's output directory (test-results/, and
  // test-results/compat/ for the version matrix, which has its own .last-run.json) and keeps it when the test passes.
  // A passed test may keep anything there, marker names included: this file's first case once built its fixture tree
  // in its own output directory, and the packer, which searched every depth for a trace.zip or an error-context.md,
  // reported one real CI failure as "4 failed test directories" and a 20x run's one failure as 61.
  inScratch('failed-test-results-nested-', (base) => {
    const results = join(base, 'test-results');
    const passed = 'unit-packer-passed-chromium';
    tree(results, {
      '.last-run.json': '{"status":"failed","failedTests":["real"]}',
      // the one test of the run that failed
      'demo-real-failed-chromium/error-context.md': 'md',
      'demo-real-failed-chromium/trace.zip': 'zip',
      // a passed test that kept a whole fake results tree in its own directory
      [`${passed}/results/.last-run.json`]: '{"status":"failed","failedTests":["a","b"]}',
      [`${passed}/results/wild-a-failed-chromium/trace.zip`]: 'zip',
      [`${passed}/results/unit-b-failed-chromium/error-context.md`]: 'md',
      [`${passed}/results/compat/.last-run.json`]: '{"status":"failed","failedTests":["d"]}',
      [`${passed}/results/compat/d-failed-chromium/trace.zip`]: 'zip',
      [`${passed}/scratch/trace.zip`]: 'zip',
      // the version matrix's run: one failed test, and a passed one with a marker below its directory
      'compat/.last-run.json': '{"status":"failed","failedTests":["e"]}',
      'compat/e-failed-compat/trace.zip': 'zip',
      'compat/f-passed-compat/fixture/error-context.md': 'md',
    });
    const out = join(base, 'failed.tgz');
    const stdout = execFileSync(process.execPath, [SCRIPT, '--results', results, '--out', out], { encoding: 'utf8' });
    expect.soft(stdout).toContain('2 failed test directories,');
    expect(members(out)).toEqual([
      '.last-run.json',
      'compat/.last-run.json',
      'compat/e-failed-compat/trace.zip',
      'demo-real-failed-chromium/error-context.md',
      'demo-real-failed-chromium/trace.zip',
    ]);
  });
});
