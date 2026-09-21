import { fileURLToPath } from 'node:url';
import { cartoBasemap } from './basemap';
import { expect, test, type Routes } from './harness';

// MIERUNE/svelte-maplibre-gl examples (Svelte 5). The friction predicted earlier, for real: NO layer or source
// has an id — the wrapper generates `svmlgl-layer-0, -1, -2` / `svmlgl-source-0` from a global counter, so an id
// says nothing and shifts when the app adds a layer. Queries here go by what a layer IS: `layerType` + `where`.
const MAPLIBRE_CSS = fileURLToPath(new URL('../../node_modules/maplibre-gl/dist/maplibre-gl.css', import.meta.url));
const routes = (center: [number, number]): Routes => [
  ...cartoBasemap('dark-matter', center),
  ['https://unpkg.com/maplibre-gl@6.10.0/dist/maplibre-gl.css', MAPLIBRE_CSS], // the wrapper links MapLibre's CSS from unpkg; same version as node_modules
  ['https://maplibre.org/maplibre-gl-js/docs/assets/us_states.geojson', 'us_states.geojson'],
  ['https://maplibre.org/maplibre-gl-js/docs/assets/earthquakes.geojson', 'earthquakes.geojson'],
];

test.describe('wild: svelte-maplibre-gl / hover-styles', () => {
  const APP = '/apps/svelte-maplibre-gl/hover-styles/';
  const state = (STATE_NAME: string) => ({ layerType: 'fill', where: { STATE_NAME } });

  test('layer ids are generated; states are addressable without knowing them', async ({ wild }) => {
    const map = await wild.open(APP, { routes: routes([-100.49, 37.83]) });
    const ours = (await map.layers()).filter((l) => l.sourceType === 'geojson');
    expect(ours.map((l) => `${l.id}:${l.type}`)).toEqual(['svmlgl-layer-0:fill', 'svmlgl-layer-1:line']);
    expect(ours[0].source).toMatch(/^svmlgl-source-\d+$/);
    await expect(map).toHaveFeature(state('Texas'));
    await expect(map.features({ layerType: 'fill', source: ours[0].source })).toHaveFeatureCount(54);
  });

  test('hover sets the feature-state the styles depend on, and a popup follows the pointer', async ({ wild }) => {
    const map = await wild.open(APP, { routes: routes([-100.49, 37.83]) });
    const texas = map.feature(state('Texas'));
    await texas.hover();
    await expect.poll(async () => (await texas.info()).state).toEqual({ hover: true });
    await expect(map).toHavePopup({ text: 'Texas' });
    await map.feature(state('Montana')).hover();
    await expect(map).toHavePopup({ text: 'Montana' });
    await expect.poll(async () => (await texas.info()).state ?? {}).not.toEqual({ hover: true }); // <FeatureState> was unmounted for Texas
  });

  test('a query by layer type that matches nothing says which layers exist', async ({ wild }) => {
    const map = await wild.open(APP, { routes: routes([-100.49, 37.83]) });
    const err = await expect(map).toHaveFeature({ layerType: 'heatmap' }, { timeout: 800 }).then(() => null, (e: Error) => e);
    expect(err?.message).toMatch(/no layer matches \{"layerType":"heatmap"\}\. Layers: .*svmlgl-layer-0\(fill,svmlgl-source-0\)/);
  });
});

test.describe('wild: svelte-maplibre-gl / clusters', () => {
  const APP = '/apps/svelte-maplibre-gl/clusters/';
  const clusters = { layerType: 'circle', where: { cluster: true } };
  const singles = { layerType: 'circle', where: { cluster: { exists: false } } };

  test('clusters and single quakes, told apart by properties (both are generated circle layers)', async ({ wild }) => {
    const map = await wild.open(APP, { routes: routes([180, 35]) });
    await expect(map).toHaveFeature(clusters);
    await expect(map).toHaveFeature(singles);
    await expect(map).toHaveFeature({ ...clusters, where: { cluster: true, point_count: { gte: 1000 } } });
  });

  test('unticking "Cluster" re-creates the source un-clustered: no clusters left, thousands of single quakes', async ({ wild, page }) => {
    const map = await wild.open(APP, { routes: routes([180, 35]) });
    const before = await map.features(singles).count();
    await page.getByRole('checkbox', { name: 'Cluster' }).click();
    await expect(map).not.toHaveFeature(clusters);
    await expect.poll(() => map.features(singles).count()).toBeGreaterThan(before + 500);
  });

  test('the map is BELOW THE FOLD (canvas at y=720 of a 720px window): actions scroll it into view first, like a Locator does', async ({ wild, page }) => {
    const map = await wild.open(APP, { routes: routes([180, 35]) });
    const top = async () => (await page.locator('canvas.maplibregl-canvas').boundingBox())!.y;
    expect(await top()).toBeGreaterThanOrEqual(720); // no pointer can reach any pixel of this map yet
    const target = (await map.features(clusters).all()).find((f) => f.pixel && f.pixel.y > 100 && f.pixel.y < 600)!;
    const cluster = map.feature({ ...clusters, where: { cluster_id: target.properties.cluster_id as number } });
    await cluster.hover();
    expect(await top()).toBeLessThan(720);
    await expect(page.locator('canvas.maplibregl-canvas')).toBeInViewport({ ratio: 0.99 });
    await map.clickAt((await cluster.info()).lngLat!); // location actions too
  });
});
