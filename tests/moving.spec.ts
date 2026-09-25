import { expect as baseExpect } from '@playwright/test';
import { test } from './fixtures'; // the network guard and the slow-machine throttle
import { geowright, expect } from '../src/playwright';
import { FAIL_FAST_MS } from './slow-machine';

/**
 * { moving: 'allow' } — acting on features that never stop moving (demo/moving.html: two patrol units
 * circling a parked one at a speed the test sets; the map never idles, so nothing here waits for idle).
 * The contract: it may take several attempts, it NEVER acts on the wrong thing.
 */

test.describe("moving: 'allow'", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/moving.html');
    await expect(geowright(page)).toHaveFeature({ layer: 'patrols', id: 1 });
  });

  test('click lands on the asked-for moving feature, not on its look-alike', async ({ page }) => {
    const map = geowright(page);
    await map.feature({ layer: 'patrols', id: 2 }).click({ moving: 'allow' });
    await baseExpect(page.getByTestId('clicked')).toHaveText('P-2');
    await map.feature({ layer: 'patrols', where: { unit: 'P-1' } }).click({ moving: 'allow' });
    await baseExpect(page.getByTestId('clicked')).toHaveText('P-1');
  });

  test('hover reaches the moving feature; rightClick and dblclick work too', async ({ page }) => {
    const map = geowright(page);
    await map.feature({ layer: 'patrols', id: 1 }).hover({ moving: 'allow' });
    await baseExpect(page.getByTestId('hovered')).toHaveText('P-1');
    await map.feature({ layer: 'patrols', id: 2 }).dblclick({ moving: 'allow' });
    await baseExpect(page.getByTestId('clicked')).toHaveText('P-2');
  });

  // 400 px/s: a 9px dot is under any given pixel for ~50ms. An attempt that arrives late must be SWALLOWED (the
  // app sees no click at all), never delivered to whatever is there instead. The same invariant holds WITHOUT the
  // option: there the two-frame check refuses almost every attempt ("unstable") — almost, because a frame in which
  // the renderer has not caught up with setData looks stable; what happens then is decided at click time as well.
  for (const moving of ['allow', undefined] as const) {
    test(`never a silent mis-click, however fast the target moves (moving: ${moving})`, async ({ page }) => {
      const map = geowright(page);
      await page.getByTestId('speed').fill('400');
      const outcome = await map.feature({ layer: 'patrols', id: 1 }).click({ moving, timeout: moving ? 8000 : 1500 }).then(() => 'clicked', (e: Error) => e.message);
      const count = Number(await page.getByTestId('click-count').textContent());
      if (outcome === 'clicked') {
        expect(count).toBe(1);
        await baseExpect(page.getByTestId('clicked')).toHaveText('P-1');
      } else {
        expect(count).toBe(0); // gave up honestly: the app never saw a click
        expect(outcome).toMatch(/click was intercepted and cancelled: target was no longer under the pointer|unstable: feature position changed/);
      }
    });
  }

  // a drag's press and lngLat()'s answer have no check at the instant the real event arrives, so on a moving target
  // they would act on a predicted, never-verified pixel. The option is refused — in the typings and at runtime.
  test("dragTo, dragBy and lngLat refuse { moving: 'allow' } and send no input", async ({ page }) => {
    const map = geowright(page);
    const patrol = map.feature({ layer: 'patrols', id: 1 });
    const before = (await map.viewState()).center;
    const refused = [
      // @ts-expect-error — `moving` is not an option of dragTo
      await patrol.dragTo({ lng: 34.81, lat: 32.09 }, { moving: 'allow', timeout: 2000 }).then(() => null, (e: Error) => e),
      // @ts-expect-error — nor of dragBy
      await patrol.dragBy({ dLng: 0.01, dLat: 0 }, { moving: 'allow', timeout: 2000 }).then(() => null, (e: Error) => e),
      // @ts-expect-error — nor of lngLat
      await patrol.lngLat({ moving: 'allow', timeout: 2000 }).then(() => null, (e: Error) => e),
    ];
    for (const [i, name] of ['dragTo', 'dragBy', 'lngLat'].entries()) {
      expect(refused[i]?.message, name).toContain(`${name}() does not take { moving: 'allow' }`);
    }
    expect((await map.viewState()).center, 'no drag reached the map').toEqual(before);
    expect(await page.getByTestId('click-count').textContent()).toBe('0');
  });

  // the location actions took `moving` in their option types and ignored it: an action at a location has no check at
  // the instant the real event arrives either. Refused the same way — in the typings and at runtime.
  test("location actions refuse { moving: 'allow' } and send no input", async ({ page }) => {
    const map = geowright(page);
    const at = { lng: 34.81, lat: 32.09 };
    const to = { lng: 34.82, lat: 32.09 };
    const o = { moving: 'allow', timeout: 2000 } as const;
    const before = (await map.viewState()).center;
    const actions: [string, () => Promise<unknown>][] = [
      // @ts-expect-error — `moving` is not an option of a location action
      ['clickAt', () => map.clickAt(at, o)],
      // @ts-expect-error — nor of dblclickAt
      ['dblclickAt', () => map.dblclickAt(at, o)],
      // @ts-expect-error — nor of rightClickAt
      ['rightClickAt', () => map.rightClickAt(at, o)],
      // @ts-expect-error — nor of hoverAt
      ['hoverAt', () => map.hoverAt(at, o)],
      // @ts-expect-error — nor of wheelAt
      ['wheelAt', () => map.wheelAt(at, -100, o)],
      // @ts-expect-error — nor of dragAt
      ['dragAt', () => map.dragAt(at, to, o)],
      // @ts-expect-error — nor of tapAt
      ['tapAt', () => map.tapAt(at, o)],
      // @ts-expect-error — nor of doubleTapAt
      ['doubleTapAt', () => map.doubleTapAt(at, o)],
      // @ts-expect-error — nor of touchDragAt
      ['touchDragAt', () => map.touchDragAt(at, to, o)],
      // @ts-expect-error — nor of pinchAt
      ['pinchAt', () => map.pinchAt(at, { scale: 2, ...o })],
      // @ts-expect-error — nor of twoFingerRotateAt
      ['twoFingerRotateAt', () => map.twoFingerRotateAt(at, { degrees: 30, ...o })],
    ];
    for (const [name, act] of actions) {
      const err = await act().then(() => null, (e: Error) => e);
      expect(err?.message, name).toContain(`${name}() does not take { moving: 'allow' }`);
      expect(err?.message, name).toContain('use click() / tap() / hover()');
    }
    expect((await map.viewState()).center, 'no input reached the map').toEqual(before);
    expect(await page.getByTestId('click-count').textContent()).toBe('0');
  });

  test('a stationary feature next to the route is unaffected by the option', async ({ page }) => {
    const map = geowright(page);
    await map.feature({ layer: 'parked', id: 9 }).click({ moving: 'allow' });
    await baseExpect(page.getByTestId('clicked')).toHaveText('P-9');
  });
});

// A moving target is resolved again when the press arrives. What the press may land on is still the ONE feature the
// query resolves to then: here the query `{ layer: 'look' }` resolves to the only visible dot (id 1) when it is aimed
// at, and at the instant of the press the app shows two others instead (one of them exactly under the pointer, above
// the aimed one, which it hides). The query now matches two features; the press must not approve whichever of them is
// under the pointer.
test("moving: 'allow' — a press that arrives when the query matches several features is swallowed, not approved", async ({ map, page }) => {
  await page.evaluate(() => {
    const w = window as any;
    const m = w.__geowright_maps.main;
    const at = (x: number, y: number) => m.unproject([x, y]).toArray();
    const dot = (id: number, o: number, c: number[]) => ({ type: 'Feature', id, properties: { kind: 'bus', o }, geometry: { type: 'Point', coordinates: c } });
    m.addSource('look', { type: 'geojson', data: { type: 'FeatureCollection', features: [dot(1, 1, at(480, 360)), dot(2, 0, at(480, 360)), dot(3, 0, at(300, 250))] } });
    // opacity from the feature-state when there is one: the app switches which dots are shown, synchronously
    m.addLayer({ id: 'look', type: 'circle', source: 'look', paint: { 'circle-radius': 12, 'circle-color': '#0a6', 'circle-opacity': ['coalesce', ['feature-state', 'o'], ['get', 'o']] } });
    w.__lookClicks = 0;
    m.on('click', 'look', () => w.__lookClicks++);
    let swapped = false;
    // registered before any check the action arms: it runs first, as if the other dots arrived just then
    window.addEventListener('pointerdown', () => {
      if (swapped) return;
      swapped = true;
      m.setFeatureState({ source: 'look', id: 1 }, { o: 0 });
      m.setFeatureState({ source: 'look', id: 2 }, { o: 1 });
      m.setFeatureState({ source: 'look', id: 3 }, { o: 1 });
    }, true);
  });
  await map.waitForIdle();
  await expect(map.features({ layer: 'look' })).toHaveFeatureCount(1);
  const err = await map.feature({ layer: 'look' }).click({ moving: 'allow', timeout: FAIL_FAST_MS }).then(() => null, (e: Error) => e);
  expect(await page.evaluate(() => (window as any).__lookClicks), 'the app got no click').toBe(0);
  expect(err?.message).toContain('strict mode violation');
});
