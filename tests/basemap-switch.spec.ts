import { test, expect } from './fixtures';
import { FAIL_FAST_MS } from './slow-machine';

/**
 * A basemap switch, the way apps do it: the user picks another basemap, and the app loads that style from its URL with
 * setStyle(url, { diff: false }), putting its own sources and layers back on top with transformStyle
 * (demo/src/main.ts). Light / dark switchers are among the most common map UIs, and the suite's only setStyle used to
 * reload the same style. Until the new basemap is in, the map has no style at all: no layer, no source. Absence cannot
 * be concluded then, whether the query names a layer or not.
 */
const rejects = (p: Promise<unknown>) => p.then(() => null, (e: Error) => e);

test("a basemap switch: the app's features before and after, no verdict of absence in between, and a click right after", async ({ map, page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const parcel = map.feature({ layer: 'parcels', id: 105 });
  const layerIds = async () => (await map.layers()).map((l) => l.id);
  await expect(parcel, 'before: the parcel is drawn on the light basemap').toBeVisibleOnMap();
  await expect(map.features({ layer: 'alerts' })).toHaveFeatureCount(3);

  let release!: () => void;
  const answer = new Promise<void>((r) => (release = r));
  await page.route('**/basemaps/dark.json', async (r) => {
    await answer; // the server answers once the assertions in between are over; the test does not sleep
    await r.fallback(); // to the fixture's basemap server (tests/fixtures.ts)
  });
  await page.getByTestId('basemap').selectOption('dark');

  // In between: the old style is gone and the new one has not arrived. (The query without a layer goes first: MapLibre
  // fades the new style's symbols in during the first frames after the switch, and those frames read as "never idle".)
  const unnamed = await rejects(expect(map).not.toHaveFeature({ where: { zoning: 'commercial' } }, { timeout: FAIL_FAST_MS }));
  const named = await rejects(expect(map).not.toHaveFeature({ layer: 'parcels', id: 105 }, { timeout: FAIL_FAST_MS }));
  release();

  // Right after the switch: the click waits for the parcel to be drawn again, and the app's handler answers it.
  await parcel.click();
  await expect(page.getByTestId('popup')).toHaveAttribute('data-id', '105');
  await expect(page.getByTestId('popup')).toHaveAttribute('data-kind', 'parcel');

  // After: the dark basemap is in, and the app's sources and layers are back on top of it.
  const after = await layerIds();
  expect(after.slice(0, 2), 'the dark basemap is underneath').toEqual(['dark-background', 'dark-basemap']);
  expect(after).toContain('parcels');
  await expect(map.features({ layer: 'parcels' })).toHaveFeatureCount(6);
  await expect(map.features({ layer: 'alerts' })).toHaveFeatureCount(3);
  await expect(map).toHaveFeature({ layer: 'buildings' }); // a vector-tile source, fetched again for the new style
  await expect(map.feature({ layer: 'stations-points', where: { name: 'Substation Alpha' } }), 'its icon was added again').toBeVisibleOnMap();
  await expect(map).not.toHaveFeature({ layer: 'parcels', where: { zoning: 'nope' } }); // a settled map gives verdicts again

  expect(unnamed?.message ?? '.not.toHaveFeature without a layer passed while the new basemap was loading').toContain('the map had not settled');
  expect(named?.message ?? '.not.toHaveFeature on a named layer passed while the new basemap was loading').toContain('no verdict');

  // And back: the light basemap, the same features.
  await page.getByTestId('basemap').selectOption('light');
  await expect.poll(async () => (await layerIds()).slice(0, 2), { message: 'the light basemap is underneath' }).toEqual(['background', 'basemap']);
  await expect(parcel).toBeVisibleOnMap();
  await expect(map.features({ layer: 'alerts' })).toHaveFeatureCount(3);
  expect(errors, 'the switch throws nothing in the page').toEqual([]);
});
