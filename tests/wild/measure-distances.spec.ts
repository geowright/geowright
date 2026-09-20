import { brightBasemap } from './basemap';
import { example, expect, test, type Routes } from './harness';
import type { LngLat } from '../../src/playwright';

// MapLibre example "Measure distances": click to add points, a line connects them in order, a DOM box
// shows the running total (turf.length, km). Clicking an EXISTING point removes it.
const CENTER: [number, number] = [2.3399, 48.8555];
const routes: Routes = [...brightBasemap(CENTER), ['https://cdn.jsdelivr.net/npm/@turf/turf@7/turf.min.js', 'vendor/turf@7/turf.min.js']];

/** Great-circle distance in km, same formula/radius turf.length() uses (mean earth radius 6371.0088 km). */
function haversineKm(a: LngLat, b: LngLat): number {
  const R = 6371.0088;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const A: LngLat = { lng: 2.32, lat: 48.85 };
const B: LngLat = { lng: 2.34, lat: 48.86 };
const C: LngLat = { lng: 2.36, lat: 48.855 };

async function readDistance(page: import('@playwright/test').Page): Promise<number | null> {
  const text = await page.locator('#distance').innerText();
  const m = /Total distance: ([\d,.]+)km/.exec(text);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

test.describe('wild: measure-distances', () => {
  test('two points draw a line whose DOM-reported length matches a haversine check', async ({ wild, page }) => {
    const map = await wild.open(example('measure-distances'), { routes });
    await map.clickAt(A);
    await map.clickAt(B);
    await expect(map.features({ layer: 'measure-points' })).toHaveFeatureCount(2);
    await expect(map.feature({ layer: 'measure-lines' })).toHaveGeometry([A, B]);
    await expect.poll(() => readDistance(page)).not.toBeNull();
    const shown = (await readDistance(page))!;
    expect(shown).toBeCloseTo(haversineKm(A, B), 1); // turf.length ~ haversine, within 100m
  });

  test('a third point extends the line and the distance grows monotonically', async ({ wild, page }) => {
    const map = await wild.open(example('measure-distances'), { routes });
    await map.clickAt(A);
    await map.clickAt(B);
    const twoPoint = (await readDistance(page))!;
    await map.clickAt(C);
    await expect(map.feature({ layer: 'measure-lines' })).toHaveGeometry([A, B, C]);
    const threePoint = (await readDistance(page))!;
    expect(threePoint).toBeGreaterThan(twoPoint);
    expect(threePoint).toBeCloseTo(haversineKm(A, B) + haversineKm(B, C), 1);
  });

  test('clicking an existing point removes it, shrinking the line and the distance', async ({ wild, page }) => {
    const map = await wild.open(example('measure-distances'), { routes });
    await map.clickAt(A);
    await map.clickAt(B);
    await map.clickAt(C);
    await expect(map.features({ layer: 'measure-points' })).toHaveFeatureCount(3);

    await map.clickAt(B); // B is an existing point: this removes it, not adds a new one
    await expect(map.features({ layer: 'measure-points' })).toHaveFeatureCount(2);
    await expect(map.feature({ layer: 'measure-lines' })).toHaveGeometry([A, C]);
    await expect.poll(() => readDistance(page)).toBeCloseTo(haversineKm(A, C), 1);
  });

  test('the distance box is empty with zero or one point on the map', async ({ wild, page }) => {
    const map = await wild.open(example('measure-distances'), { routes });
    expect(await page.locator('#distance').innerText()).toBe('');
    await map.clickAt(A);
    await expect(map.features({ layer: 'measure-points' })).toHaveFeatureCount(1);
    expect(await page.locator('#distance').innerText()).toBe(''); // one point: no line yet
    await map.clickAt(A); // clicking the only point removes it
    await expect(map.features({ layer: 'measure-points' })).toHaveFeatureCount(0);
  });

  test('the cursor is a pointer over an existing point, a crosshair elsewhere', async ({ wild, page }) => {
    const map = await wild.open(example('measure-distances'), { routes });
    await map.clickAt(A);
    await map.hoverAt(A);
    await expect(page.locator('canvas.maplibregl-canvas')).toHaveCSS('cursor', 'pointer');
    await map.hoverAt(C); // nowhere near a point
    await expect(page.locator('canvas.maplibregl-canvas')).toHaveCSS('cursor', 'crosshair');
  });
});
