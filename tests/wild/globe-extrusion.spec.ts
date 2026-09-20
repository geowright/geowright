import { DEMOTILES, example, expect, test, type Wild } from './harness';

// MapLibre example "Display a globe with a fill-extrusion layer": demotiles on a globe, switched via
// GlobeControl, plus three coloured fill-extrusion polygons from an inline GeoJSON source.
//
// FRICTION / finding: under this repo's headless software-GL setup, the fill-extrusion layer never
// paints a single pixel while globe projection is active — confirmed with a raw
// map.queryRenderedFeatures({ layers: ['extrude-polygon-layer'] }) returning 0, even zoomed in tight on
// one of the polygons. Toggling the SAME view to mercator (one click on the control, no camera change)
// makes all 3 appear immediately. So the data/style are fine; only "fill-extrusion + globe" is empty
// here. This may be a software-GL (SwiftShader) limitation rather than a general MapLibre one — the
// existing display-buildings-in-3d wild spec proves fill-extrusion paints fine under software GL on a
// flat map — but upstream globe + large fill-extrusion polygons are also independently known to be
// troublesome (maplibre/maplibre-gl-js#8248, roof z-fighting/clipping at low zoom). We did not have a
// real GPU to rule either cause out, so this is reported, not silently worked around.
const open = (wild: Wild) => wild.open(example('display-a-globe-with-a-fill-extrusion-layer'), { routes: DEMOTILES, options: { timeout: 20_000 } });

test.describe('wild: display-a-globe-with-a-fill-extrusion-layer', () => {
  test.slow(); // globe projection is slow to render under software GL

  test('opens in globe projection, centred at the longitude the example asked for', async ({ wild }) => {
    const map = await open(wild);
    const view = await map.viewState();
    expect(view.projection).toBe('globe');
    expect(view.center.lng).toBeCloseTo(30, 0);
    // Surprising: the example passes `center: [30, 40]` but no `zoom`; the rendered view lands at
    // lat≈0, zoom≈0.49 (deterministic across runs) rather than lat 40 — looks like the style's own
    // default zoom/center wins when the constructor omits `zoom`.
    expect(view.zoom).toBeCloseTo(0.49, 1);
  });

  test('the globe control toggles projection, camera unchanged', async ({ wild, page }) => {
    const map = await open(wild);
    const before = await map.viewState();
    await page.getByTitle('Disable globe').click();
    await map.waitForIdle();
    await expect.poll(async () => (await map.viewState()).projection).toBe('mercator');
    const afterOff = await map.viewState();
    expect(afterOff.center.lng).toBeCloseTo(before.center.lng, 5);
    expect(afterOff.zoom).toBeCloseTo(before.zoom, 5);

    await page.getByTitle('Enable globe').click();
    await map.waitForIdle();
    await expect.poll(async () => (await map.viewState()).projection).toBe('globe');
  });

  test('the demotiles basemap still renders and is addressable under globe projection', async ({ wild }) => {
    const map = await open(wild);
    // Kenya sits close to the view's own centre (lng 30, lat ~0).
    const kenya = map.feature({ layer: 'countries-fill', at: { lng: 37.9, lat: 0.6 } });
    await expect(await kenya.info()).toMatchObject({ properties: { NAME: 'Kenya' } });
  });

  test('the extrusions are found and clickable ON THE GLOBE — where MapLibre\'s own box queries return nothing for them', async ({ wild, page }) => {
    // History: the example run concluded "the fill-extrusion layer paints nothing on a globe" and asserted it,
    // because every viewport query said 0. A screenshot says otherwise: they are plainly drawn. MapLibre 6.10
    // answers POINT queries for fill-extrusion on a globe but not BOX / viewport queries. The adapter sweeps points.
    const map = await open(wild);
    const rawBox = await page.evaluate(() => (window as any).__geowright_maps.main.queryRenderedFeatures({ layers: ['extrude-polygon-layer'] }).length);
    expect(rawBox).toBe(0); // the upstream behaviour this exists for; if it starts failing, MapLibre fixed it
    await expect(map).toHaveFeature({ layer: 'extrude-polygon-layer', where: { color: '#ff0044' } }); // the red band round the equator
    await expect(map).toHaveFeature({ layer: 'extrude-polygon-layer', where: { color: '#22ff44' } });
    await page.evaluate(() => {
      const m = (window as any).__geowright_maps.main;
      m.on('click', (e: any) => ((window as any).__clicked = m.queryRenderedFeatures(e.point, { layers: ['extrude-polygon-layer'] })[0]?.properties.color));
    });
    await map.feature({ layer: 'extrude-polygon-layer', where: { color: '#22ff44' } }).click();
    expect(await page.evaluate(() => (window as any).__clicked)).toBe('#22ff44');
  });

  test('the same view in mercator shows all three', async ({ wild, page }) => {
    const map = await open(wild);
    await page.getByTitle('Disable globe').click(); // same camera, projection only
    await map.waitForIdle();
    await expect(map.features({ layer: 'extrude-polygon-layer' })).toHaveFeatureCount(3);
  });

  test('once visible (mercator), the three polygons carry their own colour and height', async ({ wild, page }) => {
    const map = await open(wild);
    await page.getByTitle('Disable globe').click();
    await map.waitForIdle();
    await expect(map).toHaveFeature({ layer: 'extrude-polygon-layer', where: { color: '#4400ff', height: 600000 } });
    await expect(map).toHaveFeature({ layer: 'extrude-polygon-layer', where: { color: '#22ff44', height: 450000 } });
    await expect(map).toHaveFeature({ layer: 'extrude-polygon-layer', where: { color: '#ff0044', height: 150000 } });
    const snap = await map.snapshot({ layers: ['extrude-polygon-layer'] });
    expect(snap).toContain('fill-extrusion-color is data-driven');
  });
});
