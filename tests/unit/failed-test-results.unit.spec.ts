import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
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

test('keeps every file of a failed test but its node_modules, every .last-run.json, and nothing of a passed test', () => {
  const results = test.info().outputPath('results');
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
  const out = test.info().outputPath('failed.tgz');
  const stdout = execFileSync(process.execPath, [SCRIPT, '--results', results, '--out', out], { encoding: 'utf8' });
  expect(stdout).toContain('3 failed test directories');
  expect(stdout).toContain('1 node_modules tree(s) left out');
  const members = execFileSync('tar', ['-tzf', out], { encoding: 'utf8' }).trim().split('\n').map((m) => m.replace(/^\.\//, '')).sort();
  expect(members).toEqual([
    '.last-run.json',
    'compat/.last-run.json',
    'compat/d-failed-chromium/trace.zip',
    'unit-b-failed-chromium/error-context.md',
    'unit-b-failed-chromium/tree/package.json',
    'wild-a-failed-chromium/test-failed-1.png',
    'wild-a-failed-chromium/trace.zip',
  ]);
});

test('a run with no failed test (or no results directory at all) still writes an archive', () => {
  const results = test.info().outputPath('none');
  tree(results, { '.last-run.json': '{"status":"passed","failedTests":[]}', 'unit-c-passed-chromium/out.txt': 'x' });
  const out = test.info().outputPath('none.tgz');
  expect(execFileSync(process.execPath, [SCRIPT, '--results', results, '--out', out], { encoding: 'utf8' })).toContain('0 failed test directories');
  expect(execFileSync('tar', ['-tzf', out], { encoding: 'utf8' }).trim().replace(/^\.\//, '')).toBe('.last-run.json');
  const missing = test.info().outputPath('missing.tgz');
  expect(execFileSync(process.execPath, [SCRIPT, '--results', test.info().outputPath('does-not-exist'), '--out', missing], { encoding: 'utf8' })).toContain('0 failed test directories');
  expect(execFileSync('tar', ['-tzf', missing], { encoding: 'utf8' }).trim()).toBe('');
});
