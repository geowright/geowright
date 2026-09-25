import { test as base, type BrowserContext, type Page } from '@playwright/test';
import { makeTilePng } from './tile-png';
import { BUILDINGS } from './buildings';
import { routeVectorTiles } from '../src/playwright/tiles';
import { throttleFromEnv } from './slow-machine';
import { geowright, type MapHandle } from '../src/playwright';

export { expect } from '../src/playwright';

const TILE = makeTilePng();

/**
 * Blocks every request and WebSocket of `context` to anywhere but `origin` (the exact origin, not a prefix: :41730 is not
 * :4173; a ws:// socket counts as its http:// origin), and hands each blocked URL to `blocked`. Registered on the context,
 * so a spec's own `page.route` fixtures answer first and a popup is guarded too. A request a service worker answers never
 * reaches a route: playwright.config.ts blocks service workers.
 */
export async function blockOffOrigin(context: BrowserContext, origin: string, blocked: (url: string) => void): Promise<void> {
  const allowed = new URL(origin).origin;
  await context.route(/^https?:\/\//, (route) => {
    const url = route.request().url();
    if (new URL(url).origin === allowed) return route.fallback();
    blocked(url);
    return route.abort('blockedbyclient');
  });
  const httpOrigin = (u: URL) => `${u.protocol === 'wss:' ? 'https:' : 'http:'}//${u.host}`;
  // A routed socket that is not connected to its server is opened by Playwright as a mock: closed at once instead.
  await context.routeWebSocket((u) => httpOrigin(u) !== allowed, (ws) => {
    blocked(ws.url());
    return ws.close({ code: 1008, reason: 'blocked by the test network guard' });
  });
}

/** The guard the `page` fixture put on this page's context: tests/network-guard.spec.ts asserts what it recorded. */
export const pageGuards = new WeakMap<Page, { external: string[]; check(): void }>();

/**
 * Determinism guard (decision 0021): nothing may leave the machine. Every request and WebSocket of the page's context to
 * anywhere but `origin` (the preview server) is aborted and recorded (blockOffOrigin); `check()` names them all.
 */
export async function guardNetwork(page: Page, origin: string): Promise<{ external: string[]; check(): void }> {
  const external: string[] = [];
  await blockOffOrigin(page.context(), origin, (url) => external.push(url));
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
    pageGuards.set(page, guard);
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
