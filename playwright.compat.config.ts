import { defineConfig, devices } from '@playwright/test';
import { WEBGL_SOFTWARE_FLAGS } from './playwright.config';

/**
 * The version-compat matrix: one small page and a core subset of specs against every MapLibre /
 * Mapbox-GL-v1-API major (tests/compat/libs.ts). Its own config ON PURPOSE: `npx playwright test`
 * (and the 20x flake bar) stay what they were; this runs with
 *   npm run test:compat        (= npx playwright test -c playwright.compat.config.ts)
 */
const PORT = Number(process.env.GEOWRIGHT_COMPAT_PORT ?? Number(process.env.GEOWRIGHT_PORT ?? 4173) + 2);

export default defineConfig({
  testDir: 'tests/compat',
  fullyParallel: true,
  retries: 0,
  reporter: [['list']],
  timeout: 30_000,
  expect: { timeout: 7_000 },
  outputDir: 'test-results/compat',
  use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure', viewport: { width: 1280, height: 720 } },
  projects: [{ name: 'compat', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 720 }, launchOptions: { args: WEBGL_SOFTWARE_FLAGS } } }],
  webServer: {
    command: 'node tests/compat/serve.mjs',
    env: { GEOWRIGHT_COMPAT_PORT: String(PORT) },
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
