import { test, expect } from './fixtures';

test('a map removed during a click explains the detached canvas', async ({ map, page }) => {
  await page.evaluate(() => {
    const m = (window as any).__geowright_maps.main;
    window.addEventListener('mousemove', () => m.remove(), { capture: true, once: true });
  });
  const e = await map.feature({ layer: 'alerts', id: 1 }).click({ timeout: 1200 }).then(() => null, (e: Error) => e);
  expect(e?.message).toContain('map canvas is detached from the document');
  expect(e?.message).not.toContain('could not inspect the map');
  expect(await map.snapshot()).toContain('canvas is detached from the document');
});

// MapLibre's remove() deletes the style, so its feature query answers "nothing" without throwing — and every
// negative feature assertion passed on a map nobody can see. A removed map is "could not look", never "absent".
test('a removed map is not an empty map: negative feature assertions fail on it', async ({ map, page }) => {
  await page.evaluate(() => (window as any).__geowright_maps.main.remove());
  const rejects = (p: Promise<unknown>) => p.then(() => null, (e: Error) => e);
  const not = await rejects(expect(map).not.toHaveFeature({ layer: 'alerts' }, { timeout: 1000 }));
  expect(not, 'the .not assertion passed on a map that was removed').not.toBeNull();
  expect(not?.message).toContain('map canvas is detached from the document');
  const zero = await rejects(expect(map.features({ layer: 'alerts' })).toHaveFeatureCount(0, { timeout: 1000 }));
  expect(zero, 'toHaveFeatureCount(0) passed on a map that was removed').not.toBeNull();
  const invisible = await rejects(expect(map.feature({ layer: 'alerts', id: 1 })).not.toBeVisibleOnMap({ timeout: 1000 }));
  expect(invisible, '.not.toBeVisibleOnMap passed on a map that was removed').not.toBeNull();
  const count = await rejects(map.features({ layer: 'alerts' }).count());
  expect(count?.message, 'count() of a removed map is an error, not 0').toContain('map canvas is detached from the document');
});
