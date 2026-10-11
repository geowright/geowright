#!/usr/bin/env node
// Packs the output of the FAILED tests of a Playwright run into one archive, for a CI failure artifact.
//
// The whole `test-results/` tree is not uploadable after a big run: the 20x of the full suite left 960,062 files there
// (unit tests copy small package trees into their output directories, and passed tests keep theirs), and
// actions/upload-artifact ran out of Node heap on it, twice, taking the one trace we needed with it. With `trace: 'retain-on-failure'`, a test's directory holds a
// `trace.zip` (or Playwright's `error-context.md`) only when the test failed: those directories are what a reader needs.
//
//   node scripts/failed-test-results.mjs [--results test-results] [--out test-results-failed.tgz]
//
// Playwright gives each test one directory directly under the run's output directory, and keeps it when the test passes,
// with whatever the test put there. So only those directories are looked at: a file inside a passed test's directory is
// never taken for a failed test, even one named trace.zip, error-context.md or .last-run.json (the packer's own unit
// test once kept a fake results tree there, and one real CI failure was packed as four). A directory there that holds its
// own `.last-run.json` is another run's output directory (the version matrix writes to test-results/compat): the same
// rule applies inside it.
//
// Every file of a failed test's directory goes in, except `node_modules` trees (a unit test's copied package), plus each
// run's `.last-run.json` (which names the failed tests). One archive, always written, so the upload step has a file even
// when the run failed before any test did. Exit code 0 unless the archive cannot be written.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKERS = ['trace.zip', 'error-context.md'];

export function failedTestFiles(results) {
  const files = [];
  const dirs = [];
  let skipped = 0;
  // `dir` is a run's output directory: its child directories are that run's tests.
  const run = (dir) => {
    const names = readdirSync(dir);
    if (names.includes('.last-run.json')) files.push(join(dir, '.last-run.json'));
    for (const name of names) {
      const p = join(dir, name);
      if (!statSync(p).isDirectory()) continue;
      const inner = readdirSync(p);
      if (MARKERS.some((m) => inner.includes(m))) {
        dirs.push(p);
        collect(p);
      } else if (inner.includes('.last-run.json')) run(p);
    }
  };
  const collect = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        if (name === 'node_modules') skipped++;
        else collect(p);
      } else files.push(p);
    }
  };
  if (existsSync(results)) run(results);
  return { dirs, files: files.map((f) => relative(results, f).split(sep).join('/')), skippedNodeModules: skipped };
}

export function pack(results, out) {
  const { dirs, files, skippedNodeModules } = failedTestFiles(results);
  const list = mkdtempSync(join(tmpdir(), 'failed-test-results-'));
  try {
    writeFileSync(join(list, 'files'), files.map((f) => `${f}\n`).join(''));
    // Both GNU tar and bsdtar read the member list from a file; an empty list is an empty archive.
    execFileSync('tar', ['-czf', out, '-C', existsSync(results) ? results : '.', '-T', join(list, 'files')], { stdio: 'inherit' });
  } finally {
    rmSync(list, { recursive: true, force: true });
  }
  return { dirs, files, skippedNodeModules };
}

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};

// Run, not imported: compare real paths. The module URL percent-encodes a space or an "é" and names the real path behind a
// symlink, so comparing it with the raw argv path missed in such a checkout, and the script wrote nothing and exited 0.
const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false; // argv[1] names no file: not this script
  }
})();

if (isMain) {
  const results = arg('--results', 'test-results');
  const out = arg('--out', 'test-results-failed.tgz');
  const { dirs, files, skippedNodeModules } = pack(results, out);
  const size = statSync(out).size;
  console.log(`${out}: ${dirs.length} failed test director${dirs.length === 1 ? 'y' : 'ies'}, ${files.length} file(s), ${(size / 1024).toFixed(0)} KB${skippedNodeModules ? ` (${skippedNodeModules} node_modules tree(s) left out)` : ''}`);
  for (const d of dirs) console.log(`  ${relative(results, d)}`);
}
