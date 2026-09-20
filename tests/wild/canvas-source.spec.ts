import { DEMOTILES, example, expect, test } from './harness';

// MapLibre example "Add a canvas source": a `canvas` source (`animate: true`) painted from an
// off-screen <canvas> that five circles bounce around on, forever (requestAnimationFrame).
test.describe('wild: add-a-canvas-source', () => {
  test('the canvas-source raster layer is added over the basemap and visible', async ({ wild }) => {
    const map = await wild.open(example('add-a-canvas-source'), { routes: DEMOTILES, waitForIdle: false });
    // no queryable feature exists to retry a `toHaveFeature` on (raster/canvas source): poll layers()
    // directly until the style finishes loading and the layer the app adds in `map.on('load', ...)` appears.
    await expect.poll(async () => (await map.layers()).some((l) => l.id === 'canvas-layer')).toBe(true);
    const canvasLayer = (await map.layers()).find((l) => l.id === 'canvas-layer');
    expect(canvasLayer).toMatchObject({ type: 'raster', source: 'canvas-source', visible: true });
    // MapLibre's own CanvasSource extends ImageSource without overriding `.type`, so the runtime
    // source object (and therefore geowright's layers(), which reads it) reports "image", not
    // "canvas" — an upstream quirk, faithfully passed through, not a geowright bug.
    expect(canvasLayer?.sourceType).toBe('image');
    await expect(map).toHaveView({ center: { lng: 95.899147, lat: 18.088694 }, zoom: 5 });
  });

  test('the map never becomes idle while the canvas keeps animating (animate: true)', async ({ wild }) => {
    const map = await wild.open(example('add-a-canvas-source'), { routes: DEMOTILES, waitForIdle: false });
    // an animated canvas source: nothing is loading, the camera is at rest, and frames keep coming — the error says so
    await expect(map.waitForIdle({ timeout: 2500 })).rejects.toThrow(/did not become idle \(still moving, loading tiles, or repainting\) — the map rendered \d+ frames in \d+ms with the camera at rest and no source loading: the app repaints it continuously/);
  });

  test('zooming out is clamped at the map\'s minZoom (4)', async ({ wild }) => {
    const map = await wild.open(example('add-a-canvas-source'), { routes: DEMOTILES, waitForIdle: false });
    for (let i = 0; i < 6; i++) await map.keyboard.press('-');
    await expect(map).toHaveView({ zoom: 4 });
  });

  test('the off-screen source canvas is hidden from the user (display: none)', async ({ wild, page }) => {
    await wild.open(example('add-a-canvas-source'), { routes: DEMOTILES, waitForIdle: false });
    await expect(page.locator('#canvasID')).toBeHidden();
  });

  // FIXED IN THE LIBRARY (an earlier phase): written as test.fixme — "a team wanting a pixel-content regression test for a
  // raster / canvas / image layer has no geowright API for it". `toHaveLayerPixels` is the feature-less sibling of
  // toBeVisibleOnMap: do the canvas pixels at a location change when the layer is not drawn?
  test('the canvas layer paints pixels inside its quad and nothing outside it', async ({ wild }) => {
    const map = await wild.open(example('add-a-canvas-source'), { routes: DEMOTILES, waitForIdle: false });
    // The example draws five thin circle OUTLINES at random positions and speeds: any small window is empty most of
    // the time (my first version probed 48px at the centre and failed 3 of ~6 repeats in the 20x). Probe the whole quad
    // (~200px wide at zoom 5): there are always five circles somewhere in it.
    await expect(map).toHaveLayerPixels('canvas-layer', { at: { lng: 95.9, lat: 17.7 }, radiusPx: 100 });
    await expect(map).not.toHaveLayerPixels('canvas-layer', { at: { lng: 104, lat: 17.7 } }); // east of the quad
  });
});
