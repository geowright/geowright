import { test, expect } from './fixtures';
import type { LngLat } from '../src/playwright';

/** Everything else in the suite is north-up and flat. Real maps are rotated, pitched, or a globe. */
const SQUARE: LngLat[] = [
  { lng: 34.795, lat: 32.04 },
  { lng: 34.81, lat: 32.04 },
  { lng: 34.81, lat: 32.05 },
  { lng: 34.795, lat: 32.05 },
];

test.describe('camera: rotated + pitched', () => {
  test.beforeEach(async ({ page, map }) => {
    await page.getByTestId('camera-preset').selectOption('tilted');
    await expect(map).toHaveView({ bearing: 35, pitch: 55 });
  });

  test('feature clicks still land: point, concave polygon, vector-tile polygon', async ({ map, page }) => {
    await map.feature({ layer: 'alerts', id: 1 }).click();
    await expect(page.getByTestId('popup')).toHaveAttribute('data-id', '1');
    await map.feature({ layer: 'parcels', id: 105 }).click();
    await expect(page.getByTestId('popup')).toHaveAttribute('data-id', '105');
    await map.feature({ layer: 'buildings', id: 1001 }).click({ autoPan: { lng: 34.79, lat: 32.075 } });
    await expect(page.getByTestId('popup')).toHaveAttribute('data-kind', 'building');
  });

  test('location actions: right-click reports the asked coordinate', async ({ map, page }) => {
    await map.rightClickAt({ lng: 34.8, lat: 32.1 });
    await expect(page.getByTestId('ctx-coords')).toHaveText(/^34\.800\d\d, 32\.100\d\d$|^34\.799\d\d, 32\.099\d\d$|^34\.800\d\d, 32\.099\d\d$|^34\.799\d\d, 32\.100\d\d$/);
  });

  test('drawing and geometry assertions are camera-independent', async ({ map, page }) => {
    await page.getByTestId('draw-polygon').click();
    await map.draw.polygon(SQUARE, { finish: 'click-first' });
    await expect(map.feature({ layer: 'td-polygon' })).toHaveGeometry(SQUARE);
    await page.getByTestId('draw-select').click();
    await map.feature({ layer: 'td-polygon' }).click();
    const to = { lng: 34.82, lat: 32.058 };
    await map.feature({ layer: 'td-point', where: { selectionPoint: true }, at: SQUARE[2] }).dragTo(to);
    await expect(map.feature({ layer: 'td-polygon' })).toHaveGeometry([SQUARE[0], SQUARE[1], to, SQUARE[3]]);
  });

  test('a location behind the camera is a clear error, not a wrong click', async ({ map }) => {
    // bearing 35: the camera looks north-east, so far to the south-west is behind it
    const err = await map.clickAt({ lng: 34.0, lat: 31.0 }, { timeout: 600 }).then(() => null, (e: Error) => e);
    expect(err?.message).toMatch(/outside the viewport|not on the visible map surface/);
  });

  test('snapshot pixels stay clickable under rotation and pitch', async ({ map, page }) => {
    const snap = await map.snapshot();
    expect(snap).toContain('bearing 35 pitch 55');
    // bounds are a bounding box of the rotated trapezoid; what is off-screen is decided in pixels
    expect(snap).toMatch(/OUTSIDE the viewport \(pan to see them; directions are geographic, the map is rotated 35°\): #4 to the east/);
    const [, x, y] = snap.match(/#2 Point @\((\d+),(\d+)\) id=2 name="Road closure"/)!;
    await page.mouse.click(+x, +y);
    await expect(page.getByTestId('popup')).toHaveAttribute('data-id', '2');
  });
});

test.describe('camera: globe projection', () => {
  // A whole-world globe at 1280x720 in SOFTWARE GL costs seconds per frame when the CPU is contended
  // (measured in a failed 20x: single page.evaluate round-trips of 5–10s while 400 foreign simulator
  // processes were running). test.slow() triples the timeout; it is not a retry and not a sleep.
  test.slow();
  test('near side: feature and location actions work', async ({ map, page }) => {
    await page.getByTestId('camera-preset').selectOption('globe-6');
    await expect(map).toHaveView({ zoom: 6 });
    await map.feature({ layer: 'alerts', id: 4 }).click(); // 0.42° east of the rest: ~38px away at z6
    await expect(page.getByTestId('popup')).toContainText('Far east incident');
    await map.rightClickAt({ lng: 33.5, lat: 33.0 });
    await expect(page.getByTestId('ctx-coords')).toHaveText(/^33\.(4|5)\d+, (32\.9|33\.0)\d+$/);
  });

  test('far side of the globe: a clear error instead of clicking the near side', async ({ map, page }) => {
    await page.getByTestId('camera-preset').selectOption('globe-2');
    await expect(map).toHaveView({ zoom: 1.8 });
    const err = await map.clickAt({ lng: -145, lat: -32 }, { timeout: 800 }).then(() => null, (e: Error) => e);
    expect(err?.message).toMatch(/not on the visible map surface/);
    await map.rightClickAt({ lng: 20, lat: 40 }); // visible hemisphere still works
    await expect(page.getByTestId('ctx-coords')).toHaveText(/\d/);
    const [lng, lat] = (await page.getByTestId('ctx-coords').innerText()).split(',').map(Number);
    expect(Math.abs(lng - 20)).toBeLessThan(0.4); // one pixel is ~0.2° at zoom 1.8
    expect(Math.abs(lat - 40)).toBeLessThan(0.4);
  });
});
