import { expect as baseExpect } from '@playwright/test';
import { test } from './fixtures'; // the network guard and the slow-machine throttle
import { geowright, expect } from '../src/playwright';

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

  test('a stationary feature next to the route is unaffected by the option', async ({ page }) => {
    const map = geowright(page);
    await map.feature({ layer: 'parked', id: 9 }).click({ moving: 'allow' });
    await baseExpect(page.getByTestId('clicked')).toHaveText('P-9');
  });
});
