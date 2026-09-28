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
// Every file of a failed test's directory goes in, except `node_modules` trees (a unit test's copied package), plus every
// `.last-run.json` (which names the failed tests). One archive, always written, so the upload step has a file even when
// the run failed before any test did. Exit code 0 unless the archive cannot be written.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

const MARKERS = ['trace.zip', 'error-context.md'];

export function failedTestFiles(results) {
  const files = [];
  const dirs = [];
  let skipped = 0;
  const walk = (dir) => {
    const names = readdirSync(dir);
    if (names.includes('.last-run.json')) files.push(join(dir, '.last-run.json'));
    if (MARKERS.some((m) => names.includes(m))) {
      dirs.push(dir);
      collect(dir);
      return;
    }
    for (const name of names) {
      if (name === 'node_modules') continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
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
  if (existsSync(results)) walk(results);
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

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split(sep).join('/'))) {
  const results = arg('--results', 'test-results');
  const out = arg('--out', 'test-results-failed.tgz');
  const { dirs, files, skippedNodeModules } = pack(results, out);
  const size = statSync(out).size;
  console.log(`${out}: ${dirs.length} failed test director${dirs.length === 1 ? 'y' : 'ies'}, ${files.length} file(s), ${(size / 1024).toFixed(0)} KB${skippedNodeModules ? ` (${skippedNodeModules} node_modules tree(s) left out)` : ''}`);
  for (const d of dirs) console.log(`  ${relative(results, d)}`);
}
