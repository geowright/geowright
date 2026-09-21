import { test as base } from '@playwright/test';
import { test, expect } from './fixtures';
import { geowright } from '../src/playwright';

/** The default action timeout follows the test's timeout; an action's `timeout` is a wall-clock promise. */
test.describe('timeouts', () => {
  base('default: 10s under the default 30s test timeout; an explicit option always wins', async ({ page }) => {
    expect(geowright(page).timeout).toBe(10_000);
    expect(geowright(page, { timeout: 2500 }).timeout).toBe(2500);
  });

  base('test.slow() / test.setTimeout() scale the default — also when called AFTER geowright(page)', async ({ page }) => {
    const map = geowright(page);
    base.setTimeout(90_000);
    expect(map.timeout).toBe(30_000);
    expect(geowright(page, { timeout: 2500 }).timeout).toBe(2500);
    base.setTimeout(12_000);
    expect(map.timeout).toBe(10_000); // never below the plain default
  });

  base('waitForIdle() is a load, not an action: its default is two thirds of the test timeout', async ({ page }) => {
    const map = geowright(page);
    expect(map.idleTimeout).toBe(20_000); // 30s test timeout
    base.setTimeout(90_000);
    expect(map.idleTimeout).toBe(60_000);
    expect(geowright(page, { timeout: 2500 }).idleTimeout).toBe(2500); // an explicit option applies to everything
  });

  test('an action times out by the clock even while the page cannot answer (busy main thread)', async ({ map, page }) => {
    // 4s of synchronous work in the page: every round trip into it blocks for that long.
    void page.evaluate(() => {
      const end = Date.now() + 4000;
      while (Date.now() < end);
    });
    const started = Date.now();
    const err = await map.feature({ layer: 'alerts', id: 1 }).click({ timeout: 800 }).then(() => null, (e: Error) => e);
    const took = Date.now() - started;
    expect(err?.message).toContain('timed out after 800ms');
    expect(err?.message).toContain('the page did not answer "actionPoint" in the time that was left');
    // The failure ARTEFACTS (map state, screenshot) still have to wait for the page; the verdict did not.
    expect(took).toBeLessThan(7000);
    await expect(page.getByTestId('popup')).toHaveCount(0); // and nothing was clicked afterwards
  });
});
