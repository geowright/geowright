import { test, expect } from './fixtures';
import type { LngLat } from '../src/playwright';

/** ACT gap, hard mode: drawing and editing geometry with a real draw library (terra-draw). */
const SQUARE: LngLat[] = [
  { lng: 34.825, lat: 32.04 },
  { lng: 34.85, lat: 32.04 },
  { lng: 34.85, lat: 32.055 },
  { lng: 34.825, lat: 32.055 },
];

async function drawnRing(page: import('@playwright/test').Page): Promise<number[][]> {
  const json = JSON.parse(await page.getByTestId('draw-json').innerText());
  return json[0].geometry.coordinates[0];
}

test.describe('drawing', () => {
  test('draw a polygon with real clicks; geometry lands where we asked', async ({ map, page }) => {
    await page.getByTestId('draw-polygon').click();
    await map.draw.polygon(SQUARE, { finish: 'click-first' });

    await expect(page.getByTestId('draw-count')).toHaveText('1');
    await expect(map.features({ layer: 'td-polygon' })).toHaveFeatureCount(1);

    const ring = await drawnRing(page);
    expect(ring).toHaveLength(5); // closed ring
    SQUARE.forEach((v, i) => {
      expect(ring[i][0]).toBeCloseTo(v.lng, 3); // 1px at z12 ≈ 0.00017°
      expect(ring[i][1]).toBeCloseTo(v.lat, 3);
    });
  });

  test('select a drawn polygon and drag one vertex', async ({ map, page }) => {
    await page.getByTestId('draw-polygon').click();
    await map.draw.polygon(SQUARE, { finish: 'click-first' });
    await expect(page.getByTestId('draw-count')).toHaveText('1');

    await page.getByTestId('draw-select').click();
    await map.feature({ layer: 'td-polygon' }).click();
    await expect(map.features({ layer: 'td-point', where: { selectionPoint: true } })).toHaveFeatureCount(4);

    const to = { lng: 34.86, lat: 32.065 };
    await map.feature({ layer: 'td-point', where: { selectionPoint: true }, at: SQUARE[2] }).dragTo(to);

    await expect
      .poll(async () => {
        const r = await drawnRing(page);
        return [+r[2][0].toFixed(3), +r[2][1].toFixed(3)];
      })
      .toEqual([34.86, 32.065]);
    const ring = await drawnRing(page);
    expect(ring[0][0]).toBeCloseTo(SQUARE[0].lng, 3); // other vertices untouched
    expect(ring[1][1]).toBeCloseTo(SQUARE[1].lat, 3);
  });
});
