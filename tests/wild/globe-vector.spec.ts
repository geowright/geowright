import { DEMOTILES, example, expect, test, type Wild } from './harness';
import { FAIL_FAST_MS } from '../slow-machine';

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
  // test.slow() does not touch expect's 7s, and one round trip into a globe page takes seconds on a loaded machine
  // (measured): the matchers here get the map's own 20s (`map.timeout`, set above) instead.

  test('the map comes up in globe projection at the example\'s own view', async ({ wild }) => {
    const map = await open(wild);
    await expect(map).toHaveView({ center: { lng: 0, lat: 0 }, zoom: 2 }, { timeout: map.timeout });
    expect((await map.viewState()).projection).toBe('globe');
  });

  test('a country near the centre of the globe is addressable by name and clickable', async ({ wild }) => {
    const map = await open(wild);
    // Gabon sits almost exactly under the view centre (map is centred on lng 0, lat 0).
    const gabon = map.feature({ layer: 'countries-fill', at: { lng: 11.6, lat: -0.8 } });
    await expect(await gabon.info()).toMatchObject({ properties: { NAME: 'Gabon' } });
    await gabon.click();
  });

  // Decision 0022 on a globe: an image layer over Gabon. Opaque: the click is refused and names it; translucent: it lands.
  test('an image layer drawn over a country on the globe: opaque refused, translucent clicked through', async ({ wild, page }) => {
    const map = await open(wild);
    const gabon = map.feature({ layer: 'countries-fill', at: { lng: 11.6, lat: -0.8 } });
    const veil = (opacity: number) =>
      page.evaluate((opacity) => {
        const m = (window as any).__geowright_maps.main;
        if (m.getLayer('veil')) m.removeLayer('veil');
        if (m.getSource('veil')) m.removeSource('veil');
        const c = document.createElement('canvas');
        c.width = c.height = 64;
        const g = c.getContext('2d')!;
        g.fillStyle = '#888';
        g.fillRect(0, 0, 64, 64);
        m.addSource('veil', { type: 'image', url: c.toDataURL(), coordinates: [[5, 6], [18, 6], [18, -7], [5, -7]] });
        m.addLayer({ id: 'veil', type: 'raster', source: 'veil', paint: { 'raster-opacity': opacity, 'raster-fade-duration': 0 } });
      }, opacity);
    await veil(1);
    await expect(map, 'the premise: the veil is drawn over Gabon').toHaveLayerPixels('veil', { at: { lng: 11.6, lat: -0.8 }, timeout: map.timeout });
    // a refusal waits out its timeout, and one look on a globe under software GL can take seconds: the map's own 20s
    const err = await gabon.click({ timeout: map.timeout }).then(() => null, (e: Error) => e);
    expect(err?.message.split('\n\n')[0]).toMatch(/occluded: .*raster layer "veil", drawn above "countries-fill"/);
    await veil(0.5);
    await expect(map).toHaveLayerPixels('veil', { at: { lng: 11.6, lat: -0.8 }, timeout: map.timeout });
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
    await expect(map.clickAt({ lng: 180, lat: 0 }, { timeout: 2 * FAIL_FAST_MS })).rejects.toThrow(/far side of the globe, beyond the horizon, or behind the camera/);
    // The near side is unaffected by the rejected click: the same feature is still there and clickable.
    await map.feature({ layer: 'countries-fill', at: { lng: 11.6, lat: -0.8 } }).click();
  });

  test('locations near the globe limb are refused when the projected click would land elsewhere', async ({ wild, page }) => {
    const map = await open(wild);
    await page.evaluate(() => {
      const m = (window as any).__geowright_maps.main;
      (window as any).__limbClicks = [];
      m.on('click', (event: any) => (window as any).__limbClicks.push({ lng: event.lngLat.lng, lat: event.lngLat.lat }));
    });
    for (const lng of [80, -80]) {
      await page.evaluate(() => ((window as any).__limbClicks = []));
      const error = await map.clickAt({ lng, lat: 0 }, { timeout: 2 * FAIL_FAST_MS }).then(() => null, (e: Error) => e);
      const clicks = await page.evaluate(() => (window as any).__limbClicks as Array<{ lng: number; lat: number }>);
      if (error) expect(error.message).toMatch(/not on the visible map surface/);
      else {
        expect(clicks).toHaveLength(1);
        expect(Math.abs(clicks[0].lng - lng)).toBeLessThanOrEqual(1);
        expect(Math.abs(clicks[0].lat)).toBeLessThanOrEqual(1);
      }
    }
  });

  test('countries are found WITHOUT `at`, near side only — MapLibre\'s own viewport query gets this wrong on a globe', async ({ wild, page }) => {
    // Written as test.fixme by the example run: raw map.queryRenderedFeatures() with no geometry returns ~24
    // countries here (Americas + South Asia) and omits Gabon, Nigeria… which ARE on screen; box queries return
    // the far side as well. The adapter now asks in a grid and keeps near-side pieces.
    const map = await open(wild);
    const raw = await page.evaluate(() => new Set((window as any).__geowright_maps.main.queryRenderedFeatures({ layers: ['countries-fill'] }).map((f: any) => f.properties.NAME)).size);
    expect(raw).toBeLessThan(40); // the upstream behaviour this test exists for; if this starts failing, MapLibre fixed it
    for (const NAME of ['Gabon', 'Nigeria', 'Brazil', 'Spain']) await expect(map).toHaveFeature({ layer: 'countries-fill', where: { NAME } }, { timeout: map.timeout });
    for (const NAME of ['Australia', 'Japan', 'New Zealand']) await expect(map).not.toHaveFeature({ layer: 'countries-fill', where: { NAME } }, { timeout: map.timeout }); // far side
    await map.feature({ layer: 'countries-fill', where: { NAME: 'Nigeria' } }).click();
  });

  // 'vertical-perspective' and a projection EXPRESSION render a globe too (MapLibre's createProjectionFromName):
  // the viewport-query workaround must apply to them, and the view must say so.
  for (const [name, type] of [
    ['vertical-perspective', 'vertical-perspective'],
    ['a projection expression', ['interpolate', ['linear'], ['zoom'], 10, 'vertical-perspective', 12, 'mercator']],
  ] as const) {
    test(`${name}: countries are found without \`at\`, near side only`, async ({ wild, page }) => {
      const map = await open(wild);
      await page.evaluate((type) => (window as any).__geowright_maps.main.setProjection({ type }), type as any);
      await map.waitForIdle();
      expect((await map.viewState()).projection).toMatch(/vertical-perspective/);
      expect(await map.snapshot()).toMatch(/projection [^\n]*vertical-perspective/);
      for (const NAME of ['Gabon', 'Nigeria', 'Brazil', 'Spain']) await expect(map).toHaveFeature({ layer: 'countries-fill', where: { NAME } }, { timeout: map.timeout });
      for (const NAME of ['Australia', 'Japan', 'New Zealand']) await expect(map).not.toHaveFeature({ layer: 'countries-fill', where: { NAME } }, { timeout: map.timeout });
    });
  }

  // zoomed in so far that the viewport lies inside one big piece of a country: no vertex of it is on screen,
  // yet it is drawn over the whole view.
  test('a country that fills the whole view is found, though none of its vertices is on screen', async ({ wild, page }) => {
    const map = await open(wild);
    await page.evaluate(() => (window as any).__geowright_maps.main.jumpTo({ center: [-52, -10], zoom: 8 }));
    await map.waitForIdle();
    await expect(map).toHaveFeature({ layer: 'countries-fill', where: { NAME: 'Brazil' } }, { timeout: map.timeout });
    await expect(map).not.toHaveFeature({ layer: 'countries-fill', where: { NAME: 'Gabon' } }, { timeout: map.timeout });
  });
});

