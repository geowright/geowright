import { test, expect } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * scripts/linux-suite.sh leaves a verdict file (.scratch/verdicts/linux-<sha>.ok) that release tooling takes as "the
 * suite was green on Linux for this commit". It may only do so for a run whose code IS that commit, and two checkouts
 * running it at once must not share one copy of the code. Docker is replaced by a stub on PATH that swallows the copied
 * tree and exits 0 (a green run): what is tested is the script's own bookkeeping, not the suite.
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** A throwaway checkout holding the script, with a docker stub that records its arguments. */
function checkout(name: string): { dir: string; run: () => { status: number | null; stderr: string }; dockerArgs: () => string } {
  const dir = test.info().outputPath(name);
  mkdirSync(`${dir}/scripts`, { recursive: true });
  cpSync(`${ROOT}scripts/linux-suite.sh`, `${dir}/scripts/linux-suite.sh`);
  symlinkSync(`${ROOT}node_modules`, `${dir}/node_modules`); // the script reads the installed Playwright version
  writeFileSync(`${dir}/.gitignore`, 'node_modules\n.scratch/\ntest-results-linux/\nbin/\n');
  writeFileSync(`${dir}/a.txt`, 'a\n');
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t', 'commit', '-q', '-m', 'init');
  mkdirSync(`${dir}/bin`);
  writeFileSync(`${dir}/bin/docker`, `#!/bin/bash\necho "$@" >> "${dir}/bin/docker-args"\ncat > /dev/null\nexit 0\n`);
  chmodSync(`${dir}/bin/docker`, 0o755);
  return {
    dir,
    run: () => {
      const r = spawnSync('bash', [`${dir}/scripts/linux-suite.sh`], { env: { ...process.env, PATH: `${dir}/bin:${process.env.PATH}` }, encoding: 'utf8' });
      return { status: r.status, stderr: r.stderr };
    },
    dockerArgs: () => readFileSync(`${dir}/bin/docker-args`, 'utf8'),
  };
}

const sha = (dir: string) => execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

test('a green run on a clean checkout leaves a verdict for its commit (control)', async () => {
  const c = checkout('clean');
  expect(c.run().status).toBe(0);
  expect(existsSync(`${c.dir}/.scratch/verdicts/linux-${sha(c.dir)}.ok`)).toBe(true);
});

test('a run that copied an untracked file leaves no verdict: the commit does not hold the code that ran', async () => {
  const c = checkout('untracked');
  writeFileSync(`${c.dir}/new-module.ts`, 'export const x = 1;\n'); // used by the code, never `git add`-ed
  const r = c.run();
  expect(r.status).toBe(0);
  expect(existsSync(`${c.dir}/.scratch/verdicts/linux-${sha(c.dir)}.ok`)).toBe(false);
  expect(r.stderr).toContain('untracked');
});

test('two checkouts copy their code into two different volumes', async () => {
  const a = checkout('one');
  const b = checkout('two');
  a.run();
  b.run();
  const volume = (args: string) => args.match(/-v (geowright-linux[^:]*):\/work/)?.[1];
  expect(volume(a.dockerArgs())).toBeTruthy();
  expect(volume(a.dockerArgs())).not.toBe(volume(b.dockerArgs()));
});

test('a second run in the same checkout while one is running is refused', async () => {
  const c = checkout('busy');
  mkdirSync(`${c.dir}/.scratch/linux-suite.lock`, { recursive: true }); // what a running run holds
  const r = c.run();
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain('already running');
  expect(existsSync(`${c.dir}/bin/docker-args`), 'docker was started anyway').toBe(false);
});
