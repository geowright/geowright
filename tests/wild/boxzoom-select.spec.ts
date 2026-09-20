import { DEMOTILES, example, expect, test, type Routes } from './harness';

// MapLibre example "Select features with boxZoomEnd callback": Shift+drag selects earthquakes inside
// the box (via the `boxZoom: { boxZoomEnd }` option, which replaces the default fit-to-box zoom with
// a callback); selected ids get set on the 'earthquakes-selected' layer's filter and on #selected-count.
const routes: Routes = [
  ...DEMOTILES,
  ['https://maplibre.org/maplibre-gl-js/docs/assets/earthquakes.geojson', 'earthquakes.geojson'],
];

test.describe('wild: select-features-with-boxzoomend-callback', () => {
  // FRICTION: dragAt's options TYPE includes `modifiers` (inherited from ActionOptions), so this is
  // exactly how a team would expect to write "shift+drag": `dragAt(from, to, { modifiers: ['Shift'] })`.
  // It compiles, but does nothing: `_drag` (src/playwright/index.ts) does a bare
  // `mouse.move / mouse.down / mouse.move / mouse.up` and never wraps that sequence in
  // `withModifiers`, unlike every other action (clickAt, wheelAt, ...). So the modifier key is never
  // actually held during the gesture, and MapLibre's default drag-PAN handler runs instead of
  // boxZoom. This is a real gap for any app whose box-select/box-zoom depends on a held modifier.
  // FIXED IN THE LIBRARY (an earlier phase): written as test.fixme — dragAt accepted `modifiers` in its type and dropped them.
  test('shift+drag selects earthquakes inside the box, via dragAt({ modifiers })', async ({ wild, page }) => {
    const map = await wild.open(example('select-features-with-boxzoomend-callback'), { routes });
    const from = { lng: -110, lat: 47 };
    const to = { lng: -85, lat: 26 };
    await map.dragAt(from, to, { modifiers: ['Shift'], steps: 10 });
    await map.waitForIdle();
    await expect(map).toHaveView({ zoom: 2.8 }); // no default box-zoom happened: boxZoomEnd took over
    await expect(page.locator('#selected-count')).not.toHaveText('0');
  });

  // WORKAROUND: hold Shift for real with the keyboard API around dragAt (comment above explains why).
  async function shiftDrag(map: any, page: any, from: { lng: number; lat: number }, to: { lng: number; lat: number }) {
    await page.keyboard.down('Shift');
    await map.dragAt(from, to, { steps: 10 });
    await page.keyboard.up('Shift');
    await map.waitForIdle();
  }

  test('shift+drag runs the boxZoomEnd callback (DOM count updates) and skips the default fit-to-box zoom', async ({ wild, page }) => {
    const map = await wild.open(example('select-features-with-boxzoomend-callback'), { routes });
    const before = await map.viewState();
    await shiftDrag(map, page, { lng: -110, lat: 47 }, { lng: -85, lat: 26 });
    await expect(map).toHaveView({ center: before.center, zoom: before.zoom }); // boxZoom's own handler took over: no fit-to-box
    await expect(page.locator('#selected-count')).not.toHaveText('0');
  });

  // FRICTION / surprising: the app's own `#selected-count` and `earthquakes-selected`'s filter (read
  // via page.evaluate — geowright cannot report a layer's setFilter state, so this one look is
  // reported here too) agree the selection is non-empty, but no query (geowright's, or MapLibre's own
  // queryRenderedFeatures, tried three ways, with a 1.5s grace period) ever finds a rendered feature
  // on 'earthquakes-selected' after the filter changes. This reproduces with plain MapLibre — it is a
  // property of this example/MapLibre 6.10 (a freshly-added `boxZoom` callback example, per its
  // `og:created: 2026-02-25`), not a geowright gap. A team relying on `setFilter` to re-highlight an
  // already-loaded GeoJSON layer at runtime should know queries can go stale like this.
  test('surprising: the selected-highlight layer never becomes queryable, even though the DOM says it is populated', async ({ wild, page }) => {
    const map = await wild.open(example('select-features-with-boxzoomend-callback'), { routes });
    await shiftDrag(map, page, { lng: -110, lat: 47 }, { lng: -85, lat: 26 });
    await expect(page.locator('#selected-count')).not.toHaveText('0');
    await expect(map.features({ layer: 'earthquakes-selected' })).toHaveFeatureCount(0);
  });

  test('Clear resets the selection back to 0', async ({ wild, page }) => {
    const map = await wild.open(example('select-features-with-boxzoomend-callback'), { routes });
    await shiftDrag(map, page, { lng: -110, lat: 47 }, { lng: -85, lat: 26 });
    await expect(page.locator('#selected-count')).not.toHaveText('0');
    await page.getByRole('button', { name: 'Clear' }).click();
    await expect(page.locator('#selected-count')).toHaveText('0');
  });

  test('an ordinary drag (no Shift) pans the map instead of selecting anything', async ({ wild, page }) => {
    const map = await wild.open(example('select-features-with-boxzoomend-callback'), { routes });
    const before = await map.viewState();
    await map.dragAt({ lng: -110, lat: 47 }, { lng: -85, lat: 26 }, { steps: 10 });
    await map.waitForIdle();
    await expect(map).not.toHaveView({ center: before.center });
    await expect(page.locator('#selected-count')).toHaveText('0');
  });
});
