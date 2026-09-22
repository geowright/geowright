import { cartoBasemap } from './basemap';
import { expect, test, type Routes } from './harness';

// visgl/deck.gl's MapboxOverlay React example: deck layers share MapLibre's WebGL context.
// The app's CARTO style and remote POI data are answered locally; its source stays upstream.
const center: [number, number] = [-74.012, 40.705];
const routes: Routes = [
  ...cartoBasemap('positron', center),
  ['https://raw.githubusercontent.com/visgl/deck.gl-data/master/examples/trips/pois.json', { json: [
    { coordinates: [-74.012, 40.705] }, { coordinates: [-74.014, 40.706] },
  ] }],
];

test.describe('wild: deck.gl MapboxOverlay over MapLibre', () => {
  test('the shared canvas keeps the MapLibre view, custom layers, and pitched buildings', async ({ wild }) => {
    const map = await wild.open('/apps/deck-gl/', { routes });
    await expect(map).toHaveView({ center: { lng: center[0], lat: center[1] }, zoom: 15.5, bearing: -20, pitch: 45 });
    const layers = await map.layers();
    expect(layers.filter((l) => l.type === 'custom').map((l) => l.id)).toEqual(['deckgl-pois', 'deckgl-tour-route', 'widget-title']);
    const ids = layers.map((l) => l.id);
    expect(ids.indexOf('deckgl-pois')).toBeLessThan(ids.indexOf('waterway_label')); // interleaved below labels
    await expect(map).toHaveFeature({ layer: '3d-buildings', where: { render_height: { gte: 80 } } });
  });

  test('a real click still reaches a building through the interleaved overlay', async ({ wild, page }) => {
    const map = await wild.open('/apps/deck-gl/', { routes });
    await page.evaluate(() => {
      const m = (window as any).__geowright_maps.main;
      m.on('click', (e: any) => ((window as any).__clicked = m.queryRenderedFeatures(e.point, { layers: ['3d-buildings'] })[0]?.id));
    });
    const buildings = await map.features({ layer: '3d-buildings', where: { render_height: { gte: 60 } } }).all();
    expect(buildings.length).toBeGreaterThan(0);
    const b = buildings[0];
    await map.feature({ layer: '3d-buildings', id: b.id }).click();
    expect(await page.evaluate(() => (window as any).__clicked)).toBe(b.id);
  });
});
