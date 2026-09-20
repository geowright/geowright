import { test as base } from '@playwright/test';
import { makeTilePng } from './tile-png';
import { mapwright, type MapHandle } from '../src/playwright';

export { expect } from '../src/playwright';

const TILE = makeTilePng();

export const test = base.extend<{ map: MapHandle }>({
  map: async ({ page, baseURL }, use) => {
    // Determinism guard: nothing may leave the machine. Any non-local request fails the test.
    const external: string[] = [];
    await page.route(/^https?:\/\//, (route) => {
      const url = route.request().url();
      if (url.startsWith(baseURL!)) return route.fallback();
      external.push(url);
      return route.abort();
    });
    await page.route('**/tiles/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: TILE }));
    await page.goto('/');
    const map = mapwright(page);
    await map.waitForIdle();
    await use(map);
    if (external.length) throw new Error(`external network requests are not allowed in tests:\n${external.join('\n')}`);
  },
});
