import { defineConfig, devices } from '@playwright/test';

/**
 * Chromium flags for deterministic headless WebGL (software rendering via SwiftShader).
 * Same set MapLibre GL JS uses for its own integration tests
 * (maplibre-gl-js/test/integration/lib/puppeteer_config.ts):
 *  --disable-gpu                       never touch a real GPU, even if the host has one
 *  --enable-unsafe-swiftshader         allow WebGL on the SwiftShader software rasteriser
 *                                      (Chrome blocks this by default since ~M130)
 *  --enable-features=AllowSwiftShaderFallback,AllowSoftwareGLFallbackDueToCrashes
 *                                      permit falling back to software GL at all
 */
export const WEBGL_SOFTWARE_FLAGS = [
  '--disable-gpu',
  '--enable-unsafe-swiftshader',
  '--enable-features=AllowSwiftShaderFallback,AllowSoftwareGLFallbackDueToCrashes',
];

// Port is configurable so a CI job and a local run on the SAME machine
// never share (or fight over) one preview server.
const PORT = Number(process.env.GEOWRIGHT_PORT ?? 4173);
// The "wild apps" suite (apps we did not write, tests/wild) has its own static server: see wild/serve.mjs.
export const WILD_PORT = Number(process.env.GEOWRIGHT_WILD_PORT ?? PORT + 1);

export default defineConfig({
  testDir: 'tests',
  testIgnore: 'compat/**', // the version matrix has its own config: playwright.compat.config.ts
  // A reused preview server (outside CI) is checked against this checkout's demo build: tests/stale-preview.ts.
  globalSetup: './tests/global-setup.ts',
  fullyParallel: true,
  retries: 0, // flakes must be visible
  reporter: [['list']],
  timeout: 30_000,
  expect: { timeout: 7_000 },
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    viewport: { width: 1280, height: 720 },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 720 }, launchOptions: { args: WEBGL_SOFTWARE_FLAGS } },
    },
  ],
  webServer: [
    {
      // Test the BUILT app: bundled ESM is the realistic (and harder) target.
      command: `npm run build:demo && npx vite preview demo --port ${PORT} --strictPort`,
      url: `http://localhost:${PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: 'node wild/serve.mjs',
      env: { GEOWRIGHT_WILD_PORT: String(WILD_PORT) },
      url: `http://localhost:${WILD_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
});
