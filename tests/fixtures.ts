import { test as base, type Page } from '@playwright/test';
import { makeTilePng } from './tile-png';
import { BUILDINGS } from './buildings';
import { routeVectorTiles } from '../src/playwright/tiles';
import { throttleFromEnv } from './slow-machine';
import { geowright, type MapHandle } from '../src/playwright';

export { expect } from '../src/playwright';

const TILE = makeTilePng();

/**
 * Determinism guard (decision 0009): nothing may leave the machine. Every request of the page's context to anywhere but
 * `origin` (the preview server; the exact origin, not a prefix: :41730 is not :4173) is aborted and recorded. Registered
 * on the context, so a spec's own `page.route` fixtures answer first and a popup is guarded too.
 */
export async function guardNetwork(page: Page, origin: string): Promise<{ external: string[]; check(): void }> {
  const allowed = new URL(origin).origin;
  const external: string[] = [];
  await page.context().route(/^https?:\/\//, (route) => {
    const url = route.request().url();
    if (new URL(url).origin === allowed) return route.fallback();
    external.push(url);
    return route.abort('blockedbyclient');
  });
  return {
    external,
    check() {
      if (external.length) throw new Error(`external network requests are not allowed in tests:\n${[...new Set(external)].join('\n')}`);
    },
  };
}

export const test = base.extend<{ map: MapHandle }>({
  // Every spec that uses `page` gets the guard and the slow-machine throttle, not only the ones that use `map`.
  page: async ({ page, baseURL }, use) => {
    await throttleFromEnv(page); // opt-in slow machine (tests/slow-machine.ts); nothing when unset
    const guard = await guardNetwork(page, baseURL!);
    await use(page);
    guard.check(); // fails the test, naming each URL
  },
  map: async ({ page }, use) => {
    await page.route('**/tiles/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: TILE }));
    await routeVectorTiles(page, '**/vt/buildings/**', { buildings: BUILDINGS });
    await page.goto('/');
    const map = geowright(page);
    await map.waitForIdle();
    await use(map);
  },
});
