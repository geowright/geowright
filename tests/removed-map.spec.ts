import { test, expect } from './fixtures';
import { allowForThrottle, FAIL_FAST_MS } from './slow-machine';

test('a map removed during a click explains the detached canvas', async ({ map, page }) => {
  await page.evaluate(() => {
    const m = (window as any).__geowright_maps.main;
    window.addEventListener('mousemove', () => m.remove(), { capture: true, once: true });
  });
  const e = await map.feature({ layer: 'alerts', id: 1 }).click({ timeout: FAIL_FAST_MS }).then(() => null, (e: Error) => e);
  expect(e?.message).toContain('map canvas is detached from the document');
  expect(e?.message).not.toContain('could not inspect the map');
  expect(await map.snapshot()).toContain('canvas is detached from the document');
});

// MapLibre's remove() deletes the style, so its feature query answers "nothing" without throwing — and every
// negative feature assertion passed on a map nobody can see. A removed map is "could not look", never "absent".
test('a removed map is not an empty map: negative feature assertions fail on it', async ({ map, page }) => {
  allowForThrottle(3 * FAIL_FAST_MS); // three expected failures, each waits out its timeout
  await page.evaluate(() => (window as any).__geowright_maps.main.remove());
  const rejects = (p: Promise<unknown>) => p.then(() => null, (e: Error) => e);
  const not = await rejects(expect(map).not.toHaveFeature({ layer: 'alerts' }, { timeout: FAIL_FAST_MS }));
  expect(not, 'the .not assertion passed on a map that was removed').not.toBeNull();
  expect(not?.message).toContain('map canvas is detached from the document');
  const zero = await rejects(expect(map.features({ layer: 'alerts' })).toHaveFeatureCount(0, { timeout: FAIL_FAST_MS }));
  expect(zero, 'toHaveFeatureCount(0) passed on a map that was removed').not.toBeNull();
  const invisible = await rejects(expect(map.feature({ layer: 'alerts', id: 1 })).not.toBeVisibleOnMap({ timeout: FAIL_FAST_MS }));
  expect(invisible, '.not.toBeVisibleOnMap passed on a map that was removed').not.toBeNull();
  const count = await rejects(map.features({ layer: 'alerts' }).count());
  expect(count?.message, 'count() of a removed map is an error, not 0').toContain('map canvas is detached from the document');
});

// toHavePopup and toHaveView too. A removed map still answers with its last camera, and the hit test that decides a
// popup's `feature` answers nothing on it: each of these passed.
test('a removed map is no verdict for toHavePopup and toHaveView either, in both polarities', async ({ map, page }) => {
  await map.feature({ layer: 'alerts', id: 1 }).click();
  await expect(map).toHavePopup({ feature: { layer: 'alerts', id: 1 } });
  const { zoom } = await map.viewState();
  await page.evaluate(() => (window as any).__geowright_maps.main.remove());
  const verdict = (p: Promise<unknown>) => p.then(() => 'passed', (e: Error) => (e.message.includes('map canvas is detached from the document') ? 'no verdict: detached' : e.message));
  const t = { timeout: FAIL_FAST_MS };
  expect({
    'not.toHavePopup({ feature })': await verdict(expect(map).not.toHavePopup({ feature: { layer: 'alerts', id: 1 } }, t)),
    'not.toHavePopup()': await verdict(expect(map).not.toHavePopup({}, t)),
    'not.toHaveView({ zoom: 3 })': await verdict(expect(map).not.toHaveView({ zoom: 3 }, t)),
    'toHaveView({ zoom: its last zoom })': await verdict(expect(map).toHaveView({ zoom }, t)),
  }).toEqual({
    'not.toHavePopup({ feature })': 'no verdict: detached',
    'not.toHavePopup()': 'no verdict: detached',
    'not.toHaveView({ zoom: 3 })': 'no verdict: detached',
    'toHaveView({ zoom: its last zoom })': 'no verdict: detached',
  });
});
