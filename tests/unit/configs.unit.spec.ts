import { test, expect } from '@playwright/test';
import { readdirSync, readFileSync } from 'node:fs';
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
