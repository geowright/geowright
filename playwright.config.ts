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

export default defineConfig({
  testDir: 'tests',
  fullyParallel: true,
  retries: 0, // flakes must be visible
  reporter: [['list']],
  timeout: 30_000,
  expect: { timeout: 7_000 },
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure',
    viewport: { width: 1280, height: 720 },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 720 }, launchOptions: { args: WEBGL_SOFTWARE_FLAGS } },
    },
  ],
  webServer: {
    // Test the BUILT app: bundled ESM is the realistic (and harder) target.
    command: 'npm run build:demo && npm run preview',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
