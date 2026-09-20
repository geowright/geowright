import { DEMOTILES, example, expect, test } from './harness';

// MapLibre example "Create a draggable point": a single circle the user drags with the mouse;
// hovering highlights it, dragging moves the underlying GeoJSON feature and fills in a coordinates readout.
test.describe('wild: create-a-draggable-point', () => {
  test('the coordinates readout is hidden until the point has been dragged once', async ({ wild, page }) => {
    await wild.open(example('create-a-draggable-point'), { routes: DEMOTILES });
    await expect(page.locator('#coordinates')).toBeHidden();
  });

  test('hovering the point highlights it and shows a move cursor', async ({ wild, page }) => {
    const map = await wild.open(example('create-a-draggable-point'), { routes: DEMOTILES });
    await map.feature({ layer: 'point' }).hover();
    await expect(page.locator('canvas.maplibregl-canvas')).toHaveCSS('cursor', 'move');
    expect(await map.snapshot({ layers: ['point'] })).toContain('teal(#3bb2d0)');
  });

  test('dragging the point moves the feature on the map AND fills in the DOM coordinates readout, in agreement', async ({ wild, page }) => {
    const map = await wild.open(example('create-a-draggable-point'), { routes: DEMOTILES });
    const target = { lng: 24.5, lat: -12.3 };
    await map.feature({ layer: 'point' }).dragTo(target);

    await expect(map.feature({ layer: 'point' })).toHaveGeometry({ type: 'Point', coordinates: [target.lng, target.lat] }, { tolerancePx: 3 });

    const text = await page.locator('#coordinates').textContent();
    const [, lngText] = /Longitude: ([-\d.]+)/.exec(text ?? '') ?? [];
    const [, latText] = /Latitude: ([-\d.]+)/.exec(text ?? '') ?? [];
    // one screen pixel at this zoom is a fair fraction of a degree; the DOM readout and the map
    // feature come from the SAME pointer position, so they must agree within a pixel's worth of degrees.
    expect(Number(lngText)).toBeCloseTo(target.lng, 0);
    expect(Number(latText)).toBeCloseTo(target.lat, 0);
  });

  test('the point can be dragged again to a second location (the drag handlers survive a full drag cycle)', async ({ wild, page }) => {
    const map = await wild.open(example('create-a-draggable-point'), { routes: DEMOTILES });
    await map.feature({ layer: 'point' }).dragTo({ lng: 24.5, lat: -12.3 });
    const second = { lng: -60, lat: 15 };
    await map.feature({ layer: 'point' }).dragTo(second);

    await expect(map.feature({ layer: 'point' })).toHaveGeometry({ type: 'Point', coordinates: [second.lng, second.lat] }, { tolerancePx: 3 });
    await expect(page.locator('#coordinates')).toContainText('Longitude: -6');
  });

  test('the cursor returns to the map\'s default "grab" (not stuck on "grabbing") after the drag ends', async ({ wild, page }) => {
    // the app's onUp clears its own inline cursor override; what's then visible is MapLibre's base
    // stylesheet default for an interactive, pannable map (.maplibregl-canvas-container: cursor: grab).
    const map = await wild.open(example('create-a-draggable-point'), { routes: DEMOTILES });
    await map.feature({ layer: 'point' }).dragTo({ lng: 24.5, lat: -12.3 });
    await expect(page.locator('canvas.maplibregl-canvas')).toHaveCSS('cursor', 'grab');
  });
});
