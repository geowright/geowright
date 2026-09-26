import { test, expect } from '@playwright/test';
import core from '../../playwright.config';
import compat from '../../playwright.compat.config';

// A committed test.only would make CI (and the 20x) run only that test, and pass. Both configs refuse one on CI; locally
// it stays usable while debugging. (Checked against the environment this runs in: removing the option fails it anywhere.)
test('both Playwright configs forbid test.only on CI', () => {
  for (const [name, config] of [['playwright.config.ts', core], ['playwright.compat.config.ts', compat]] as const) {
    expect(config.forbidOnly, name).toBe(!!process.env.CI);
  }
});
