import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { geowright, type MapHandle } from '../src/playwright';
import { allowForThrottle, block, FAIL_FAST_MS } from './slow-machine';

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

  /**
   * The page answers every round trip but the first call of `method`, which keeps its main thread busy for `ms` first:
   * a page that stalls in the middle of an action (after it found the pixel, say).
   */
  const stallOnce = (page: Page, method: string, ms: number) =>
    page.evaluate(([method, ms]) => {
      const api = (window as any).__geowright;
      const original = api[method];
      api[method] = (...args: unknown[]) => {
        api[method] = original;
        const end = performance.now() + ms;
        while (performance.now() < end);
        return original(...args);
      };
    }, [method, ms] as const);

  // The round trips of an action between finding the pixel and sending the input — arming the click-time check, the
  // autoPan reveal, reading the lng/lat — waited for a page that stalled there for as long as it stalled: the action
  // then carried on, and succeeded or failed long after its timeout.
  const STALL = 3 * FAIL_FAST_MS;
  for (const [name, method, act] of [
    ['feature().click: arming its click-time check', 'armClick', (map: MapHandle) => map.feature({ layer: 'alerts', id: 1 }).click({ timeout: FAIL_FAST_MS })],
    ['feature().click { moving }: disarming after a miss', 'disarmClick', (map: MapHandle) => map.feature({ layer: 'alerts', id: 999 }).click({ moving: 'allow', timeout: FAIL_FAST_MS })],
    ['feature().click { autoPan }: the reveal', 'reveal', (map: MapHandle) => map.feature({ layer: 'alerts', id: 4 }).click({ autoPan: true, timeout: FAIL_FAST_MS })],
    ['clickAt { autoPan }: the reveal', 'revealWorld', (map: MapHandle) => map.clickAt({ lng: 35.2, lat: 32.08 }, { autoPan: true, timeout: FAIL_FAST_MS })],
    ['feature().lngLat: reading the lng/lat', 'worldAt', (map: MapHandle) => map.feature({ layer: 'alerts', id: 1 }).lngLat({ timeout: FAIL_FAST_MS })],
    ['feature().dragBy: reading the lng/lat it drags from', 'worldAt', (map: MapHandle) => map.feature({ layer: 'alerts', id: 1 }).dragBy({ dLng: 0.001, dLat: 0 }, { timeout: FAIL_FAST_MS })],
  ] as const) {
    test(`${name}: a page that stalls there fails the action at its timeout`, async ({ map, page }) => {
      await stallOnce(page, method, STALL);
      const started = Date.now();
      const err = await act(map).then(() => null, (e: Error) => e);
      const took = Date.now() - started;
      expect(err?.message, name).toContain(`timed out after ${FAIL_FAST_MS}ms`);
      expect(err?.message, name).toMatch(/the page did not answer "\w+" in the time that was left/);
      expect(took, `${name}: rejected after ${took}ms, with a ${FAIL_FAST_MS}ms timeout and a ${STALL}ms stall`).toBeLessThan(2 * FAIL_FAST_MS);
    });
  }

  // After the input: the page said nothing about where the click landed (it stalled right after the press). The click
  // cannot be recalled, and the action used to wait for the answer for as long as the stall lasted, then report what it
  // said. Now it fails at its timeout, says the click was sent and unconfirmed, and never sends it again.
  test('feature().click: a page that stalls after the press fails after input at its timeout, and the click is not sent again', async ({ map, page }) => {
    allowForThrottle(STALL); // it waits for the stall to end
    await page.evaluate(() => {
      const w = window as any;
      w.__alertClicks = 0;
      w.__geowright_maps.main.on('click', 'alerts', () => w.__alertClicks++);
    });
    await stallOnce(page, 'disarmClick', STALL);
    const started = Date.now();
    const err = await map.feature({ layer: 'alerts', id: 1 }).click({ timeout: FAIL_FAST_MS }).then(() => null, (e: Error) => e);
    const took = Date.now() - started;
    expect(err?.message).toMatch(/click\(\): the click was sent once, and the page did not say where it landed within the \d+ms timeout \(a busy main thread: heavy rendering, or an overloaded machine\)\. It is not sent again\./);
    expect(took, `rejected after ${took}ms, with a ${FAIL_FAST_MS}ms timeout and a ${STALL}ms stall`).toBeLessThan(2 * FAIL_FAST_MS);
    await expect.poll(() => page.evaluate(() => (window as any).__alertClicks), { timeout: 2 * STALL }).toBe(1); // (read once the stall is over)
    await new Promise((r) => setTimeout(r, 100)); // and stays 1
    expect(await page.evaluate(() => (window as any).__alertClicks)).toBe(1);
  });

  test.describe('touch', () => {
    test.use({ hasTouch: true });
    test('feature().tap: a page that stalls arming its check fails the action at its timeout', async ({ map, page }) => {
      await stallOnce(page, 'armClick', STALL);
      const started = Date.now();
      const err = await map.feature({ layer: 'alerts', id: 1 }).tap({ timeout: FAIL_FAST_MS }).then(() => null, (e: Error) => e);
      const took = Date.now() - started;
      expect(err?.message).toContain(`timed out after ${FAIL_FAST_MS}ms`);
      expect(err?.message).toContain('the page did not answer "armClick"');
      expect(took, `rejected after ${took}ms, with a ${FAIL_FAST_MS}ms timeout and a ${STALL}ms stall`).toBeLessThan(2 * FAIL_FAST_MS);
    });
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
    ['waitForIdle()', (map: MapHandle) => map.waitForIdle({ timeout: TIMEOUT })],
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

  // A matcher polls until its deadline; the poll still running then is abandoned. When the page answered an earlier poll,
  // that answer is what the failure reports: "the page did not answer" only when it never did. The page here answers
  // the first look, then blocks inside the second one past the deadline. (Blocking from a timer the first look set raced
  // the delivery of the first answer: under load the test then saw no answer at all.)
  const stopsAfterFirstLook = (page: Page, method: string) =>
    page.evaluate(([method, ms]) => {
      const api = (window as any).__geowright;
      const orig = api[method];
      let looks = 0;
      api[method] = (...args: unknown[]) => {
        if (looks++ === 1) { const end = performance.now() + ms; while (performance.now() < end); }
        return orig(...args);
      };
    }, [method, 2 * FAIL_FAST_MS] as const);

  test('a matcher whose page stops answering after its first look reports what it last saw, not "the page did not answer"', async ({ map, page }) => {
    await stopsAfterFirstLook(page, 'findChecked');
    const err = await expect(map).toHaveFeature({ layer: 'alerts', id: 999 }, { timeout: FAIL_FAST_MS }).then(() => null, (e: Error) => e);
    expect(err?.message).toContain('Received: 0 match(es)');
  });

  test('toHaveView whose page stops answering after its first look reports the camera it last saw', async ({ map, page }) => {
    await stopsAfterFirstLook(page, 'viewChecked');
    const err = await expect(map).toHaveView({ zoom: 3 }, { timeout: FAIL_FAST_MS }).then(() => null, (e: Error) => e);
    expect(err?.message).not.toContain('did not answer');
    expect(err?.message).toMatch(/"zoom":12/);
  });

  // ...and reports THAT poll's findings, not what the abandoned poll had reset before its round trip.
  for (const [name, method, look, received] of [
    ['not.toHaveFeature', 'findChecked', (map: MapHandle) => expect(map).not.toHaveFeature({ layer: 'alerts', id: 1 }, { timeout: FAIL_FAST_MS }), 'Received: 1 match(es)'],
    ['toHaveFeatureCount', 'findChecked', (map: MapHandle) => expect(map.features({ layer: 'alerts', id: 1 })).toHaveFeatureCount(3, { timeout: FAIL_FAST_MS }), 'Received: 1\n'],
    ['toHaveGeometry', 'compareGeometry', (map: MapHandle) => expect(map.feature({ layer: 'alerts', id: 1 })).toHaveGeometry({ type: 'Point', coordinates: [0, 0] }, { timeout: FAIL_FAST_MS }), 'Geometry on the map (data): {"type":"Point"'],
  ] as const) {
    test(`${name} whose page stops answering after its first look reports that look`, async ({ map, page }) => {
      await expect(map).toHaveFeature({ layer: 'alerts', id: 1 });
      await stopsAfterFirstLook(page, method);
      const err = await look(map).then(() => null, (e: Error) => e);
      expect(err, 'the assertion fails: the page saw the opposite').not.toBeNull();
      expect(err!.message).toContain(received);
      expect(err!.message).not.toContain('never checked');
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

  // A SLOW page (every look answers, in 700 ms: more than the room kept for an answer) is not a stalled one: when the
  // attempts before answered, the failure is what they answered, with the map state; "the page did not answer" only
  // when it never did.
  test('an action whose last attempt is abandoned on a slow page reports what the attempts before answered', async ({ map, page }) => {
    await page.getByTestId('alert-name').fill('Covering 106');
    await page.getByTestId('alert-lng').fill('34.800');
    await page.getByTestId('alert-lat').fill('32.060');
    await page.getByTestId('alert-submit').click();
    await expect(map).toHaveFeature({ layer: 'alerts', where: { name: 'Covering 106' } });
    await page.evaluate(() => {
      const api = (window as any).__geowright;
      const orig = api.actionPoint;
      api.actionPoint = async (...a: unknown[]) => {
        const end = performance.now() + 700;
        while (performance.now() < end);
        return orig(...a);
      };
    });
    const err = await map.feature({ layer: 'parcels', id: 106 }).click({ timeout: FAIL_FAST_MS }).then(() => null, (e: Error) => e);
    expect(err?.message).toContain('occluded');
    expect(err?.message).not.toContain('did not answer');
    expect(err?.message, 'the map state is attached to it').toContain('What is on the map');
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
