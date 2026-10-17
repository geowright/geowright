import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import core from '../../playwright.config';
import compat from '../../playwright.compat.config';

// A committed test.only would make CI (and the 20x) run only that test, and pass. Both configs refuse one on CI; locally
// it stays usable while debugging. (Checked against the environment this runs in: removing the option fails it anywhere.)
test('both Playwright configs forbid test.only on CI', () => {
  for (const [name, config] of [['playwright.config.ts', core], ['playwright.compat.config.ts', compat]] as const) {
    expect(config.forbidOnly, name).toBe(!!process.env.CI);
  }
});

// A step name with ": " inside an unquoted YAML scalar is a mapping inside a mapping: GitHub fails the whole workflow
// in 0 s, on every push that touches it (seen on the packing step of the failure upload). The yaml package is not a
// dependency; the one shape that bit is checked by hand.
test('no workflow step name holds ": " unquoted', () => {
  const dir = new URL('../../.github/workflows/', import.meta.url);
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.yml'))) {
    const lines = readFileSync(new URL(file, dir), 'utf8').split('\n');
    for (const [i, line] of lines.entries()) {
      const m = /^\s*-?\s*name:\s+(.*)$/.exec(line);
      if (m && !/^['"]/.test(m[1]) && / |\t/.test(m[1]) && m[1].includes(': ')) {
        throw new Error(`${file}:${i + 1}: an unquoted step name with ": " in it — quote it, or reword:\n${line}`);
      }
    }
  }
});

// In a .gitignore, `#` starts a comment only at the start of a line: `foo   # why` is the pattern "foo   # why", which
// matches nothing (seen on the CI failure archive's line, which then sat untracked after every local run of its script).
const GITIGNORE = fileURLToPath(new URL('../../.gitignore', import.meta.url));

test('no .gitignore line carries a comment after its pattern', () => {
  for (const [i, line] of readFileSync(GITIGNORE, 'utf8').split('\n').entries()) {
    if (!line.startsWith('#') && /\s#/.test(line)) {
      throw new Error(`.gitignore:${i + 1}: git reads the comment as part of the pattern — put it on its own line above:\n${line}`);
    }
  }
});

test('git ignores the archive scripts/failed-test-results.mjs writes by default', () => {
  const dir = test.info().outputPath('repo');
  mkdirSync(dir, { recursive: true });
  copyFileSync(GITIGNORE, `${dir}/.gitignore`);
  // Only this .gitignore decides (a developer's `*.tgz` anywhere else would hide the defect): no global or system config,
  // no GIT_DIR from a hook, no excludes file (git reads $XDG_CONFIG_HOME/git/ignore or ~/.config/git/ignore by default,
  // config or not) and no info/exclude from a template.
  const env: NodeJS.ProcessEnv = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v;
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'core.excludesFile=/dev/null', '-C', dir, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '--template=');
  execFileSync(process.execPath, [fileURLToPath(new URL('../../scripts/failed-test-results.mjs', import.meta.url))], { cwd: dir, stdio: 'ignore' });
  expect(existsSync(`${dir}/test-results-failed.tgz`)).toBe(true);
  expect(git('status', '--porcelain', '--untracked-files=all').trim()).toBe('?? .gitignore');
});

// CI shares its machine, so both configs pin two workers there; a developer's machine keeps Playwright's default (half the
// cores). Read back the way Playwright resolves them: `--list` loads a config and reports the worker count it settled on
// (no browser, no web server). The default is whatever `--workers=50%` resolves to, so no CPU arithmetic is repeated here.
const PLAYWRIGHT_CLI = fileURLToPath(new URL('../../node_modules/@playwright/test/cli.js', import.meta.url));

function resolvedWorkers(config: string, ci: boolean, extra: string[] = []): number {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(CI|PW_|PLAYWRIGHT_|TEST_)/.test(k)) env[k] = v; // a nested run starts clean
  if (ci) env.CI = 'true';
  const out = execFileSync(process.execPath, [PLAYWRIGHT_CLI, 'test', '--list', '--reporter=json', '-c', config, ...extra], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(out).config.workers;
}

for (const config of ['playwright.config.ts', 'playwright.compat.config.ts']) {
  test(`${config} runs two workers on CI and Playwright's default workers elsewhere`, () => {
    test.setTimeout(90_000); // three nested Playwright starts, on a machine that may be the loaded one this test is about
    expect(resolvedWorkers(config, true), 'CI set').toBe(2);
    expect(resolvedWorkers(config, false), 'CI unset').toBe(resolvedWorkers(config, false, ['--workers=50%']));
  });
}
