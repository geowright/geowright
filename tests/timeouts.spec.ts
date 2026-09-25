import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { geowright, type MapHandle } from '../src/playwright';

/** The default action timeout follows the test's timeout; an action's `timeout` is a wall-clock promise. */
test.describe('timeouts', () => {
  test('default: 10s under the default 30s test timeout; an explicit option always wins', async ({ page }) => {
    expect(geowright(page).timeout).toBe(10_000);
    expect(geowright(page, { timeout: 2500 }).timeout).toBe(2500);
  });

  test('test.slow() / test.setTimeout() scale the default — also when called AFTER geowright(page)', async ({ page }) => {
    const map = geowright(page);
    test.setTimeout(90_000);
    expect(map.timeout).toBe(30_000);
    expect(geowright(page, { timeout: 2500 }).timeout).toBe(2500);
    test.setTimeout(12_000);
    expect(map.timeout).toBe(10_000); // never below the plain default
  });

  test('waitForIdle() is a load, not an action: its default is two thirds of the test timeout', async ({ page }) => {
    const map = geowright(page);
    expect(map.idleTimeout).toBe(20_000); // 30s test timeout
    test.setTimeout(90_000);
    expect(map.idleTimeout).toBe(60_000);
    expect(geowright(page, { timeout: 2500 }).idleTimeout).toBe(2500); // an explicit option applies to everything
  });

  test('a map whose web worker never starts: waitForIdle() says so, not just "not finished loading"', async ({ page }) => {
    // The worker script is not found — what Vite's dev server does to MapLibre 6 without optimizeDeps.exclude. The
    // dense page holds only inline GeoJSON: nothing to download, so nothing but the worker can be missing.
    await page.route('**/maplibre/maplibre-gl-worker.mjs', (route) => route.fulfill({ status: 404, body: 'not found' }));
    await page.goto('/dense.html');
    const err = await geowright(page).waitForIdle({ timeout: 8000 }).then(() => null, (e: Error) => e);
    expect(err?.message).toContain('timed out after 8000ms');
    expect(err?.message).toMatch(/source\(s\) (lots, assets|assets, lots) hold inline GeoJSON/);
    expect(err?.message).toContain('DEAD WORKER');
  });

  /** Synchronous work in the page: every round trip into it waits until it ends. Started, not awaited. */
  const block = (page: Page, ms: number) =>
    void page
      .evaluate((ms) => {
        const end = Date.now() + ms;
        while (Date.now() < end);
      }, ms)
      .catch(() => {});

  const BUSY = 5000;
  const TIMEOUT = 1000;

  // the verdict was abandoned at the deadline, but the map state, the screenshot and the click-time disarm then
  // waited for the busy page (an action returned when the page answered, ~5 s here); clickAt never abandoned at all.
  test('an action on a page that cannot answer rejects at its timeout, not when the page answers', async ({ map, page }) => {
    for (const [name, act] of [
      ['feature().click', () => map.feature({ layer: 'alerts', id: 1 }).click({ timeout: TIMEOUT })],
      ['clickAt', () => map.clickAt({ lng: 34.78, lat: 32.08 }, { timeout: TIMEOUT })],
      ['feature().info', () => map.feature({ layer: 'alerts', id: 1 }).info({ timeout: TIMEOUT })],
    ] as const) {
      await expect(map).toHaveView({ zoom: 12 }); // the page answers again: the previous block is over
      block(page, BUSY);
      const started = Date.now();
      const err = await act().then(() => null, (e: Error) => e);
      const took = Date.now() - started;
      expect(err?.message, name).toContain(`timed out after ${TIMEOUT}ms`);
      expect(err?.message, name).toMatch(/the page did not answer "\w+" in the time that was left/);
      expect(took, `${name} rejected ${took}ms after it started, with a ${TIMEOUT}ms timeout and the page busy for ${BUSY}ms`).toBeLessThan(2 * TIMEOUT);
    }
    await expect(page.getByTestId('popup')).toHaveCount(0); // and nothing was clicked afterwards
  });

  // an assertion's polls (the settle wait, the query, the camera read) and marker() / popup() waited for a busy page
  // without a bound: they failed when the page answered (~5 s here), not at their timeout; and a failed assertion then
  // waited for the page again for its map state and screenshot.
  for (const [name, look] of [
    ['toHaveFeature', (map: MapHandle) => expect(map).toHaveFeature({ layer: 'alerts', id: 999 }, { timeout: TIMEOUT })],
    ['not.toHaveFeature', (map: MapHandle) => expect(map).not.toHaveFeature({ layer: 'alerts', id: 1 }, { timeout: TIMEOUT })],
    ['toHaveFeatureCount', (map: MapHandle) => expect(map.features({ layer: 'alerts' })).toHaveFeatureCount(99, { timeout: TIMEOUT })],
    ['toBeVisibleOnMap', (map: MapHandle) => expect(map.feature({ layer: 'alerts', id: 1 })).toBeVisibleOnMap({ timeout: TIMEOUT })],
    ['toHaveGeometry', (map: MapHandle) => expect(map.feature({ layer: 'alerts', id: 1 })).toHaveGeometry({ type: 'Point', coordinates: [0, 0] }, { timeout: TIMEOUT })],
    ['toHavePopup', (map: MapHandle) => expect(map).toHavePopup({}, { timeout: TIMEOUT })],
    ['toHaveView', (map: MapHandle) => expect(map).toHaveView({ zoom: 3 }, { timeout: TIMEOUT })],
    ['marker()', (map: MapHandle) => map.marker({ at: { lng: 34.84, lat: 32.12 } }, { timeout: TIMEOUT })],
    ['popup()', (map: MapHandle) => map.popup({}, { timeout: TIMEOUT })],
  ] as const) {
    test(`${name} on a page that cannot answer fails at its timeout, not when the page answers`, async ({ map, page }) => {
      block(page, BUSY);
      const started = Date.now();
      const err = await look(map).then(() => null, (e: Error) => e);
      const took = Date.now() - started;
      expect(err?.message, name).toMatch(/the page did not answer "\w+" in the time that was left/);
      expect(took, `${name} failed ${took}ms after it started, with a ${TIMEOUT}ms timeout and the page busy for ${BUSY}ms`).toBeLessThan(2 * TIMEOUT);
    });
  }

  // a last attempt that started with a few ms left was abandoned for want of them, and the timeout then blamed
  // "a busy main thread" on an idle page, burying the real reason (here: occluded). timeout: 1 makes it certain.
  test('a timeout on an idle page gives the real reason, not "a busy main thread"', async ({ map, page }) => {
    await page.getByTestId('alert-name').fill('Covering 106');
    await page.getByTestId('alert-lng').fill('34.800');
    await page.getByTestId('alert-lat').fill('32.060');
    await page.getByTestId('alert-submit').click();
    await expect(map).toHaveFeature({ layer: 'alerts', where: { name: 'Covering 106' } });
    for (const timeout of [1, 150, 400, 700]) {
      const err = await map.feature({ layer: 'parcels', id: 106 }).click({ timeout }).then(() => null, (e: Error) => e);
      expect(err?.message, `timeout ${timeout}`).toContain(`timed out after ${timeout}ms — occluded`);
      expect(err?.message, `timeout ${timeout}`).not.toContain('did not answer');
    }
  });

  // every point of a multi-point action had its own full timeout: a drag waited for its start, then as long
  // again for its end.
  test('a multi-point action has ONE timeout, shared by its points', async ({ map, page }) => {
    const timeout = 2000;
    // The camera turns until the app stops it at half the timeout (the start point waits for that); the end point is
    // off-screen. One shared deadline fails at ~timeout; a fresh timeout per point would take ~1.5x. The stop comes from
    // an app timer, not from the animation's own duration: on a starved machine frames come late, a timer much less so.
    await page.evaluate((ms) => {
      const m = (window as any).__geowright_maps.main;
      m.easeTo({ bearing: 90, duration: 60_000 });
      setTimeout(() => m.stop(), ms);
    }, timeout * 0.5);
    const started = Date.now();
    const err = await map.dragAt({ lng: 34.78, lat: 32.08 }, { lng: 50, lat: 32.08 }, { timeout }).then(() => null, (e: Error) => e);
    const took = Date.now() - started;
    expect(err?.message).toContain('map.dragAt(to)');
    expect(err?.message).toContain(`timed out after ${timeout}ms — location is outside the viewport`);
    expect(took, `dragAt({ timeout: ${timeout} }) took ${took}ms`).toBeLessThan(timeout * 1.5);
  });

  // a failing toHaveLayerPixels projected its failure mark with clientPoint(), a full action timeout (≥ 10 s)
  // of waiting for a location that is off-screen — after the assertion's own timeout.
  test('a failing toHaveLayerPixels fails at its timeout', async ({ map }) => {
    const started = Date.now();
    const err = await expect(map).toHaveLayerPixels('basemap', { at: { lng: 100, lat: 0 }, timeout: TIMEOUT }).then(() => null, (e: Error) => e);
    const took = Date.now() - started;
    expect(err?.message).toContain('outside the viewport');
    expect(took, `took ${took}ms`).toBeLessThan(3 * TIMEOUT);
  });

  // as in Playwright, `timeout: 0` means no timeout — it used to mean ONE attempt.
  test('timeout: 0 means no timeout, as in Playwright', async ({ map, page }) => {
    // The app adds a layer a little later (its own timer: the test does not sleep).
    const addLater = (id: string) =>
      page.evaluate((id) => {
        const m = (window as any).__geowright_maps.main;
        setTimeout(() => {
          m.addSource(id, { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [34.79, 32.07] } } });
          m.addLayer({ id, type: 'circle', source: id, paint: { 'circle-radius': 10, 'circle-color': '#f0f' } });
        }, 1200);
      }, id);
    await addLater('late0');
    await expect(map).toHaveFeature({ layer: 'late0' }, { timeout: 0 });
    await addLater('late1');
    await map.feature({ layer: 'late1' }).hover({ timeout: 0 });
    await addLater('late2');
    expect((await geowright(page, { timeout: 0 }).feature({ layer: 'late2' }).info()).layer).toBe('late2');
  });
});
