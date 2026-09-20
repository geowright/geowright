import { test as base, expect } from './fixtures';
import { geowright, type LngLat, type MapHandle } from '../src/playwright';

/**
 * A second draw library (mapbox-gl-draw on MapLibre 6): the same gesture helpers, a different
 * `finish`. Proves `draw.*` is input choreography, not a terra-draw binding.
 */
const test = base.extend<{ draw2: MapHandle }>({
  draw2: async ({ page }, use) => {
    await page.goto('/draw2.html');
    const map = geowright(page);
    await map.waitForIdle();
    await use(map);
  },
});

const TRIANGLE: LngLat[] = [
  { lng: 34.76, lat: 32.07 },
  { lng: 34.8, lat: 32.07 },
  { lng: 34.78, lat: 32.095 },
];

test.describe('second draw library: mapbox-gl-draw', () => {
  test('polygon finishes on double-click of the last vertex', async ({ draw2, page }) => {
    await page.getByTestId('draw-polygon').click();
    await draw2.draw.polygon(TRIANGLE, { finish: 'dblclick' });
    await expect(page.getByTestId('draw-count')).toHaveText('1');
    // mapbox-gl-draw keeps features in a 'hot' (being edited) or 'cold' source; the shape may be in either
    await expect(draw2.feature({ layer: ['gl-draw-polygon-fill.cold', 'gl-draw-polygon-fill.hot'] })).toHaveGeometry(TRIANGLE);
  });

  test('line finishes on Enter', async ({ draw2, page }) => {
    await page.getByTestId('draw-line').click();
    await draw2.draw.line(TRIANGLE, { finish: 'enter' });
    await expect(page.getByTestId('draw-count')).toHaveText('1');
    await expect(draw2.feature({ layer: ['gl-draw-lines.cold', 'gl-draw-lines.hot'], where: { 'meta:type': 'LineString' } })).toHaveGeometry(TRIANGLE);
  });
});
