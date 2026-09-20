import { example, expect, rasterTiles, test, type Routes } from './harness';
import { syntheticTerrain } from './terrain';

// MapLibre example "3D Terrain": raster basemap + hillshade + terrain, pitch 70°. No vector features at
// all — what a team can test here is the camera, the controls, and that LOCATIONS still mean what they say
// when the ground is not flat.
const CENTER: [number, number] = [11.39085, 47.27574];
const routes: Routes = [rasterTiles(/^https:\/\/a\.tile\.openstreetmap\.org\//), ...syntheticTerrain('https://tiles.mapterhorn.com/tilejson.json', CENTER)];

// Dozens of DEM + hillshade tiles at pitch 70 in software GL: the first idle can take >10 s on a busy machine.
const SLOW = { timeout: 30_000 };

test.describe('wild: 3d-terrain', () => {
  test.slow(); // terrain + hillshade at pitch 70 in software GL

  const north = (km: number) => ({ lng: CENTER[0], lat: CENTER[1] + km / 111.32 });

  /** The example has no click handler: record where MapLibre says the real click landed. */
  const recordClicks = (page: import('@playwright/test').Page) =>
    page.evaluate(() => (window as any).__geowright_maps.main.on('click', (e: any) => ((window as any).__clicked = { lng: e.lngLat.lng, lat: e.lngLat.lat })));

  test('a click at a location lands on that location, on the plain and up on the ridge', async ({ wild, page }) => {
    const map = await wild.open(example('3d-terrain'), { routes, options: SLOW });
    await recordClicks(page);
    for (const at of [north(1), north(5.5)]) {
      // 5.5 km north is 1,700 m up the south face of the ridge
      await map.clickAt(at);
      const clicked = await page.evaluate(() => (window as any).__clicked);
      expect(Math.hypot((clicked.lng - at.lng) * 75, (clicked.lat - at.lat) * 111.32)).toBeLessThan(0.15); // km
    }
  });

  test('a location hidden BEHIND the ridge is refused, not clicked through the mountain', async ({ wild }) => {
    const map = await wild.open(example('3d-terrain'), { routes, options: SLOW });
    const err = await map.clickAt(north(8), { timeout: 1500 }).then(() => null, (e: Error) => e);
    expect(err?.message).toMatch(/not on the visible map surface/);
  });

  test('switching terrain off with the map control flattens the ridge: the hidden place becomes clickable', async ({ wild, page }) => {
    const map = await wild.open(example('3d-terrain'), { routes, options: SLOW });
    await recordClicks(page);
    await page.locator('button.maplibregl-ctrl-terrain-enabled').click();
    await expect(page.locator('button.maplibregl-ctrl-terrain')).toBeVisible();
    await map.clickAt(north(8));
    const clicked = await page.evaluate(() => (window as any).__clicked);
    expect(Math.abs(clicked.lat - north(8).lat) * 111.32).toBeLessThan(0.15);
  });

  test('the snapshot says what kind of map this is: terrain on, pixel-only layers, nothing to list', async ({ wild }) => {
    const map = await wild.open(example('3d-terrain'), { routes, options: SLOW });
    const snap = await map.snapshot();
    expect(snap).toContain('pitch 70');
    expect(snap).toContain('terrain on');
    expect(snap).toContain('pixel-only layers (nothing to query): osm(raster) hills(hillshade)');
    expect(snap).not.toContain('visible but empty');
  });

  test('keyboard panning updates the URL hash the example maintains', async ({ wild, page }) => {
    const map = await wild.open(example('3d-terrain'), { routes, options: SLOW });
    await map.keyboard.press('ArrowRight');
    await expect(page).toHaveURL(/#12\/47\.27574\/11\.4\d+\/0\/70/);
  });
});
