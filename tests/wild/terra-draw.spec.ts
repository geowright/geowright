import { brightBasemap } from './basemap';
import { example, expect, test, type Routes } from './harness';
import type { LngLat } from '../../src/playwright';

// MapLibre example "Draw geometries with terra-draw": the @watergis/maplibre-gl-terradraw control, a
// thin wrapper (DOM buttons + toolbar) around terra-draw + terra-draw-maplibre-gl-adapter (same
// adapter/layer ids as tests/draw.spec.ts: td-point, td-linestring, td-polygon/-outline).
const CENTER: [number, number] = [-91.874, 42.76];
const routes: Routes = [
  ...brightBasemap(CENTER),
  ['https://cdn.jsdelivr.net/npm/@watergis/maplibre-gl-terradraw@1.0.1/dist/maplibre-gl-terradraw.umd.js', 'vendor/maplibre-gl-terradraw@1.0.1/maplibre-gl-terradraw.umd.js'],
  ['https://cdn.jsdelivr.net/npm/@watergis/maplibre-gl-terradraw@1.0.1/dist/maplibre-gl-terradraw.css', 'vendor/maplibre-gl-terradraw@1.0.1/maplibre-gl-terradraw.css'],
];

const mode = (name: string) => `.maplibregl-terradraw-add-${name}-button`;

const SQUARE: LngLat[] = [
  { lng: -91.92, lat: 42.79 },
  { lng: -91.86, lat: 42.79 },
  { lng: -91.86, lat: 42.75 },
  { lng: -91.92, lat: 42.75 },
];

test.describe('wild: draw-geometries-with-terra-draw', () => {
  test('the Point button, then a real click, adds a td-point at that location', async ({ wild, page }) => {
    const map = await wild.open(example('draw-geometries-with-terra-draw'), { routes });
    await page.locator(mode('point')).click();
    await map.clickAt({ lng: -91.9, lat: 42.77 });
    await expect(map.feature({ layer: 'td-point' })).toHaveGeometry({ type: 'Point', coordinates: [-91.9, 42.77] });
  });

  test('the Polygon button, then click-first-to-finish, lands the ring where we clicked', async ({ wild, page }) => {
    const map = await wild.open(example('draw-geometries-with-terra-draw'), { routes });
    await page.locator(mode('polygon')).click();
    await map.draw.polygon(SQUARE, { finish: 'click-first' });
    await expect(map.feature({ layer: 'td-polygon' })).toHaveGeometry(SQUARE);
  });

  test('the Linestring button, then click-last-to-finish, lands the path where we clicked', async ({ wild, page }) => {
    const map = await wild.open(example('draw-geometries-with-terra-draw'), { routes });
    const path = [SQUARE[0], SQUARE[1], SQUARE[2]];
    await page.locator(mode('linestring')).click();
    await map.draw.line(path, { finish: 'click-last' });
    await expect(map.feature({ layer: 'td-linestring' })).toHaveGeometry(path);
  });

  test('the Rectangle button draws corner-to-corner with a click-move-click gesture (no drag threshold)', async ({ wild, page }) => {
    const map = await wild.open(example('draw-geometries-with-terra-draw'), { routes });
    const a = { lng: -91.94, lat: 42.79 };
    const b = { lng: -91.86, lat: 42.75 };
    await page.locator(mode('rectangle')).click();
    await map.draw.rectangle(a, b); // default gesture: click-move-click
    const corners: LngLat[] = [a, { lng: b.lng, lat: a.lat }, b, { lng: a.lng, lat: b.lat }];
    await expect(map.feature({ layer: 'td-polygon', where: { mode: 'rectangle' } })).toHaveGeometry(corners);
  });

  test('the Circle button draws centre-to-edge with a click-move-click gesture', async ({ wild, page }) => {
    const map = await wild.open(example('draw-geometries-with-terra-draw'), { routes });
    const centre = { lng: -91.83, lat: 42.73 };
    const edge = { lng: -91.81, lat: 42.73 };
    await page.locator(mode('circle')).click();
    await map.draw.circle(centre, edge); // default gesture: click-move-click (this mode has no drag threshold to offset it)
    await expect(map.feature({ layer: 'td-polygon', where: { mode: 'circle' } })).toHaveGeometry({ circle: { center: centre, edge } });
  });

  test('Select and Delete start disabled and enable once something is drawn; Delete clears the map', async ({ wild, page }) => {
    const map = await wild.open(example('draw-geometries-with-terra-draw'), { routes });
    await expect(page.locator(mode('select'))).toBeDisabled();
    await expect(page.locator('.maplibregl-terradraw-delete-button')).toBeDisabled();

    await page.locator(mode('polygon')).click();
    await map.draw.polygon(SQUARE, { finish: 'click-first' });
    await expect(map).toHaveFeature({ layer: 'td-polygon' });
    await expect(page.locator(mode('select'))).toBeEnabled();
    await expect(page.locator('.maplibregl-terradraw-delete-button')).toBeEnabled();

    await page.locator('.maplibregl-terradraw-delete-button').click();
    // Delete stops terra-draw, and it REMOVES its layers. A query on a layer that does not exist has no verdict (a typo
    // must not pass a `.not`, so the removal is asserted on the layer list.
    await expect.poll(async () => (await map.layers()).map((l) => l.id)).not.toContain('td-polygon');
    await expect(page.locator('.maplibregl-terradraw-delete-button')).toBeDisabled();
  });
});
