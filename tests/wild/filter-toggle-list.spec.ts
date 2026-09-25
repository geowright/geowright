import { brightBasemap } from './basemap';
import { example, expect, test } from './harness';
import { FAIL_FAST_MS } from '../slow-machine';

// MapLibre example "Filter symbols by toggling a list": one symbol layer per icon TYPE
// (poi-theatre, poi-bar, poi-bicycle, poi-music), a checkbox per layer built from the data. The
// underlying sprite icon name is `${icon}_11` (an OpenFreeMap/OpenMapTiles convention), not the
// bare icon name.
const routes = brightBasemap([-77.04, 38.907], { icons: ['theatre_11', 'bar_11', 'bicycle_11', 'music_11'] });

// The three "music" places and the two "theatre" places share IDENTICAL properties (only
// `{ icon: 'music' }` / `{ icon: 'theatre' }`) and have no feature id — only their coordinates
// (baked into the vendored example's `places` GeoJSON) tell them apart.
const musicAt = [
  { lng: -77.031706, lat: 38.914581 },
  { lng: -77.020945, lat: 38.878241 },
  { lng: -77.007481, lat: 38.876516 },
];

test.describe('wild: filter-symbols-by-toggling-a-list', () => {
  test('one layer + checked checkbox per icon type found in the data', async ({ wild, page }) => {
    const map = await wild.open(example('filter-symbols-by-toggling-a-list'), { routes });
    const checkboxes = page.locator('#filter-group input[type="checkbox"]');
    await expect(checkboxes).toHaveCount(4);
    for (const cb of await checkboxes.all()) await expect(cb).toBeChecked();
    for (const icon of ['theatre', 'bar', 'bicycle', 'music']) {
      await expect(map).toHaveFeature({ layer: `poi-${icon}`, where: { icon } });
    }
  });

  test('unchecking a box hides that icon layer; checking it again brings it back', async ({ wild, page }) => {
    const map = await wild.open(example('filter-symbols-by-toggling-a-list'), { routes });
    await expect(map).toHaveFeature({ layer: 'poi-bicycle' });
    await page.locator('label[for="poi-bicycle"]').click(); // real input: the visible label, not the hidden checkbox
    await expect(map).not.toHaveFeature({ layer: 'poi-bicycle' });
    await expect(map).toHaveFeature({ layer: 'poi-theatre' }); // the other layers are unaffected
    await page.locator('label[for="poi-bicycle"]').click();
    await expect(map).toHaveFeature({ layer: 'poi-bicycle' });
  });

  test('each of the 3 identical "music" symbols is individually addressable BY LOCATION', async ({ wild }) => {
    const map = await wild.open(example('filter-symbols-by-toggling-a-list'), { routes });
    // Without `at`, nothing in the query language can single one of these three out: same layer,
    // same (only) property, no id. `at` pins the query to one rendered pixel, which resolves it.
    for (const at of musicAt) {
      const f = await map.feature({ layer: 'poi-music', at }).info();
      expect(f.properties).toEqual({ icon: 'music' });
      expect(f.lngLat!.lng).toBeCloseTo(at.lng, 3);
      expect(f.lngLat!.lat).toBeCloseTo(at.lat, 3);
    }
  });

  test(
    'three "music" POIs with no id and identical properties are counted as 3 (was 1: fixed in the library)',
    async ({ wild }) => {
      // FIXED IN THE LIBRARY: this test was written as `test.fixme` — id-less features with identical
      // properties used to collapse into ONE. The engine now splits same-key, id-less pieces by whether they touch on screen.
      const map = await wild.open(example('filter-symbols-by-toggling-a-list'), { routes });
      await expect(map.features({ layer: 'poi-music' })).toHaveFeatureCount(3);
      // What actually happens: MapLibre's queryRenderedFeatures correctly returns 3 rendered
      // instances, but geowright's engine groups rendered pieces into "one logical feature" by
      // `${layer}|${id}|${JSON.stringify(properties)}` (src/inpage/engine.ts `key()`/`group()`) so
      // that a polygon split across tiles is counted once. With no id and identical properties,
      // three UNRELATED point features collide onto that same key and are reported as one:
      // `map.features({ layer: 'poi-music' }).count()` === 1, not 3. `at`-scoped queries (tested
      // above) sidestep it because they narrow to one rendered pixel before grouping; any
      // viewport-wide count or non-`at` `feature()` query on layers like this one cannot.
    },
  );
});

test('wild: filter-symbols-by-toggling-a-list › a missing sprite icon is named in the failure, not blamed on "collision"', async ({ wild }) => {
  // the sprite lacks "bar_11": MapLibre silently draws nothing for that layer
  const broken = brightBasemap([-77.04, 38.907], { icons: ['theatre_11', 'bicycle_11', 'music_11'] });
  const map = await wild.open(example('filter-symbols-by-toggling-a-list'), { routes: broken });
  const err = await expect(map).toHaveFeature({ layer: 'poi-bar' }, { timeout: FAIL_FAST_MS }).then(() => null, (e: Error) => e);
  expect(err?.message).toContain('its icon image "bar_11" is not in the style');
});
