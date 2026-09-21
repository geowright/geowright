import { DEMOTILES, example, expect, test, type Wild } from './harness';

// MapLibre example "Display a globe with a vector map": demotiles switched to globe projection on
// 'style.load'. No interactivity of its own — the tests exercise the LIBRARY's globe support:
// addressing a feature near the centre vs. heavily foreshortened near the limb, and the "far side of
// the globe" failure mode for a raw location click.
//
// FRICTION: with the default 10s waitForIdle budget, running this file's tests fully in parallel
// (5 workers, each rendering a globe under software GL) occasionally timed out waiting for idle purely
// from CPU contention — not from the app or the assertions (serialized, or with fewer workers, it never
// did). Raised to 20s here rather than in the shared harness, consistent with test.slow() already
// budgeting more time for this file.
const open = (wild: Wild) => wild.open(example('display-a-globe-with-a-vector-map'), { routes: DEMOTILES, options: { timeout: 20_000 } });

test.describe('wild: display-a-globe-with-a-vector-map', () => {
  test.slow(); // globe projection is slow to render under software GL

  test('the map comes up in globe projection at the example\'s own view', async ({ wild }) => {
    const map = await open(wild);
    await expect(map).toHaveView({ center: { lng: 0, lat: 0 }, zoom: 2 });
    expect((await map.viewState()).projection).toBe('globe');
  });

  test('a country near the centre of the globe is addressable by name and clickable', async ({ wild }) => {
    const map = await open(wild);
    // Gabon sits almost exactly under the view centre (map is centred on lng 0, lat 0).
    const gabon = map.feature({ layer: 'countries-fill', at: { lng: 11.6, lat: -0.8 } });
    await expect(await gabon.info()).toMatchObject({ properties: { NAME: 'Gabon' } });
    await gabon.click();
  });

  test('a country near the limb of the globe is still hit-testable despite heavy foreshortening', async ({ wild }) => {
    const map = await open(wild);
    // India: real centroid ~78E, well past the view's reported east bound (~76.6), so on screen it is
    // compressed hard against the limb (its rendered pixel sits ~250px from centre, close to the ~257px
    // ceiling the globe projection compresses everything into at this zoom).
    const india = map.feature({ layer: 'countries-fill', at: { lng: 72.8, lat: 19 } });
    const info = await india.info();
    expect(info.properties.NAME).toBe('India');
    const distFromCentre = Math.hypot(info.pixel!.x - 640, info.pixel!.y - 360);
    expect(distFromCentre).toBeGreaterThan(200); // meaningfully nearer the limb than Gabon (~60px out)
    await india.hover();
  });

  test('a location on the far side of the globe fails clearly, not by hitting the near side', async ({ wild }) => {
    const map = await open(wild);
    // The view is centred on (0,0); (180,0) is its antipode, always on the far side / behind the camera.
    await expect(map.clickAt({ lng: 180, lat: 0 }, { timeout: 2000 })).rejects.toThrow(/far side of the globe, beyond the horizon, or behind the camera/);
    // The near side is unaffected by the rejected click: the same feature is still there and clickable.
    await map.feature({ layer: 'countries-fill', at: { lng: 11.6, lat: -0.8 } }).click();
  });

  test('countries are found WITHOUT `at`, near side only — MapLibre\'s own viewport query gets this wrong on a globe', async ({ wild, page }) => {
    // Written as test.fixme by the example run: raw map.queryRenderedFeatures() with no geometry returns ~24
    // countries here (Americas + South Asia) and omits Gabon, Nigeria… which ARE on screen; box queries return
    // the far side as well. The adapter now asks in a grid and keeps near-side pieces.
    const map = await open(wild);
    const raw = await page.evaluate(() => new Set((window as any).__geowright_maps.main.queryRenderedFeatures({ layers: ['countries-fill'] }).map((f: any) => f.properties.NAME)).size);
    expect(raw).toBeLessThan(40); // the upstream behaviour this test exists for; if this starts failing, MapLibre fixed it
    for (const NAME of ['Gabon', 'Nigeria', 'Brazil', 'Spain']) await expect(map).toHaveFeature({ layer: 'countries-fill', where: { NAME } });
    for (const NAME of ['Australia', 'Japan', 'New Zealand']) await expect(map).not.toHaveFeature({ layer: 'countries-fill', where: { NAME } }); // far side
    await map.feature({ layer: 'countries-fill', where: { NAME: 'Nigeria' } }).click();
  });
});
