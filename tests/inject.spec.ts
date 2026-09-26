import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { geowright } from '../src/playwright';

/**
 * The in-page engine is injected once per document. Concurrent first calls (a user's Promise.all, the library's own
 * fire-and-forget disarm next to a retry, two maps on one page) each found it missing, and each injected it again,
 * replacing the engines and leaking the old adapters' map listeners.
 */
const countInjections = (page: Page) =>
  page.addInitScript(() => {
    let v: unknown;
    Object.defineProperty(window, '__geowright', {
      configurable: true,
      get: () => v,
      set: (x) => {
        (window as any).__gwInjections = ((window as any).__gwInjections ?? 0) + 1;
        v = x;
      },
    });
  });

test('concurrent first calls on a fresh document inject the engine once', async ({ map: _map, page }) => {
  await countInjections(page);
  await page.reload();
  await page.waitForFunction(() => (window as any).__geowright_maps?.main?.loaded?.());
  const m = geowright(page);
  await Promise.all([m.layers(), m.viewState(), m.features({ layer: 'alerts' }).count()]);
  expect(await page.evaluate(() => (window as any).__gwInjections)).toBe(1);
});

