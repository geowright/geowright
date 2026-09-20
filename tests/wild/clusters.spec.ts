import { DEMOTILES, example, expect, test, type Routes } from './harness';

// MapLibre example "Create and style clusters": a clustered GeoJSON source (USGS earthquakes, no feature
// ids), data-driven cluster colours, click-to-expand, popup on an unclustered point.
const routes: Routes = [
  ...DEMOTILES,
  ['https://maplibre.org/maplibre-gl-js/docs/assets/earthquakes.geojson', 'earthquakes.geojson'],
];

test.describe('wild: create-and-style-clusters', () => {
  test('clusters and single earthquakes are both addressable, without feature ids', async ({ wild }) => {
    const map = await wild.open(example('create-and-style-clusters'), { routes });
    await expect(map.features({ layer: 'unclustered-point' })).toHaveFeatureCount(8);
    await expect(map).toHaveFeature({ layer: 'clusters', where: { point_count: { gte: 1000 } } });
    // the earthquakes carry their identity in a PROPERTY called "id"; the features themselves have none
    const big = await map.feature({ layer: 'unclustered-point', where: { id: 'us2000ar20' } }).info();
    expect(big.id).toBeUndefined();
    expect(big.properties.mag).toBe(7.1);
  });

  test('clicking a cluster zooms into it', async ({ wild }) => {
    const map = await wild.open(example('create-and-style-clusters'), { routes });
    const before = await map.viewState();
    const cluster = map.feature({ layer: 'clusters', where: { point_count: { gte: 1000 } } });
    const at = await cluster.lngLat();
    await cluster.click();
    await expect.poll(async () => (await map.viewState()).zoom).toBeGreaterThan(before.zoom + 0.5);
    await map.waitForIdle();
    const after = await map.viewState();
    expect(Math.hypot(after.center.lng - at.lng, after.center.lat - at.lat)).toBeLessThan(1.5); // eased to the cluster
  });

  test('clicking a single earthquake opens its popup on it', async ({ wild }) => {
    const map = await wild.open(example('create-and-style-clusters'), { routes });
    const quake = { layer: 'unclustered-point', where: { id: 'us2000ar20' } };
    await map.feature(quake).click();
    await expect(map).toHavePopup({ feature: quake, text: 'magnitude: 7.1' });
    await expect(await map.popup()).toContainText('Was there a tsunami?: no');
  });

  test('the cursor turns into a pointer over a cluster', async ({ wild, page }) => {
    const map = await wild.open(example('create-and-style-clusters'), { routes });
    await map.feature({ layer: 'clusters', where: { point_count: { gte: 1000 } } }).hover();
    await expect(page.locator('canvas.maplibregl-canvas')).toHaveCSS('cursor', 'pointer');
  });
});
