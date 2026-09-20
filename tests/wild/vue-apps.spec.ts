import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { maptilerStreetsBasemap } from './basemap';
import { DEMOTILES, expect, test, type Routes } from './harness';

// indoorequal/vue-maplibre-gl docs examples (Vue 3). The hook is ONE line here too, but not the usual one: a Vue
// template expression cannot see `window` (templates only get a whitelist of globals), so the line reaches it
// through the map: `e.map.getContainer().ownerDocument.defaultView` — see wild/apps/vue-maplibre-gl/UPSTREAM.md.
const QUAKES = JSON.parse(readFileSync(fileURLToPath(new URL('../../wild/fixtures/earthquakes.geojson', import.meta.url)), 'utf8')) as { features: { properties: { felt: number | null } }[] };
const felt = (n: number) => QUAKES.features.filter((f) => f.properties.felt === n).length;

test.describe('wild: vue-maplibre-gl / filter', () => {
  const routes: Routes = [...DEMOTILES, ['https://maplibre.org/maplibre-gl-js/docs/assets/earthquakes.geojson', 'earthquakes.geojson']];
  const LAYER = 'eathquakes'; // sic — the example's own typo; explicit ids are whatever the app says

  test('shows the quakes felt by 4 people — whole world at zoom 0, several world copies on screen, each quake counted once', async ({ wild }) => {
    const map = await wild.open('/apps/vue-maplibre-gl/filter/', { routes });
    await expect(map.features({ layer: LAYER })).toHaveFeatureCount(felt(4));
    await expect(map).not.toHaveFeature({ layer: LAYER, where: { felt: { ne: 4 } } });
  });

  test('ticking the checkbox swaps the layer filter to felt == 5', async ({ wild, page }) => {
    const map = await wild.open('/apps/vue-maplibre-gl/filter/', { routes });
    await page.getByLabel('Apply felt filter').check();
    await expect(map.features({ layer: LAYER })).toHaveFeatureCount(felt(5));
    await expect(map).not.toHaveFeature({ layer: LAYER, where: { felt: 4 } });
  });
});

test.describe('wild: vue-maplibre-gl / geojson (a line that grows every second)', () => {
  const routes = maptilerStreetsBasemap([-122.4837, 37.8338]);

  test('the line gets longer while we watch — app-level timers, no map signal', async ({ wild }) => {
    const map = await wild.open('/apps/vue-maplibre-gl/geojson/', { routes });
    const line = map.feature({ layer: 'geojson' });
    const vertices = async () => ((await line.geometry()) as { coordinates: number[][] }).coordinates.length;
    await expect.poll(vertices, { timeout: 15_000 }).toBeGreaterThanOrEqual(3);
    const n = await vertices();
    await expect.poll(vertices, { timeout: 15_000 }).toBeGreaterThan(n);
  });
});

test.describe('wild: vue-maplibre-gl / marker-popup', () => {
  const at = { lng: 12.550343, lat: 55.665957 };
  const routes = maptilerStreetsBasemap([at.lng, at.lat]);

  test('the marker opens its popup; the link INSIDE the popup closes it', async ({ wild }) => {
    const map = await wild.open('/apps/vue-maplibre-gl/marker-popup/', { routes });
    await (await map.marker({ at })).click();
    await expect(map).toHavePopup({ at, text: 'Hello', tolerancePx: 50 }); // anchored above the default pin
    await (await map.popup()).getByRole('link', { name: 'Close popup' }).click();
    await expect(map).not.toHavePopup();
  });

  test('zooming with the navigation control keeps the marker on its coordinate', async ({ wild, page }) => {
    const map = await wild.open('/apps/vue-maplibre-gl/marker-popup/', { routes });
    await page.getByRole('button', { name: 'Zoom in' }).click();
    await expect(map).toHaveView({ zoom: 9 });
    await expect(await map.marker({ at })).toBeVisible();
  });
});
