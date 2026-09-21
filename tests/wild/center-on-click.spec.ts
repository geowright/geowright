import { DEMOTILES, example, expect, test, type Routes } from './harness';

// MapLibre example "Center the map on a clicked symbol": map.loadImage() fetches a real PNG
// (custom_marker.png, a BSD-3 repo asset) and addImage()s it; 3 identical, propertyless, id-less
// points use it; clicking one flyTo()s the map to centre on that exact point.
const routes: Routes = [...DEMOTILES, ['https://maplibre.org/maplibre-gl-js/docs/assets/custom_marker.png', 'custom_marker.png']];

const points: Array<{ lng: number; lat: number }> = [
  { lng: -91.395263671875, lat: -0.9145729757782163 },
  { lng: -90.32958984375, lat: -0.6344474832838974 },
  { lng: -91.34033203125, lat: 0.01647949196029245 },
];

test.describe('wild: center-the-map-on-a-clicked-symbol', () => {
  test('the custom-marker image loads and all 3 symbols render with it', async ({ wild }) => {
    const map = await wild.open(example('center-the-map-on-a-clicked-symbol'), { routes });
    // No id, no properties at all ({}); only their locations tell them apart.
    for (const at of points) {
      const f = await map.feature({ layer: 'symbols', at }).info();
      expect(f.properties).toEqual({});
      expect(f.geometryType).toBe('Point');
    }
  });

  test('clicking a symbol flies the camera to centre exactly on it', async ({ wild }) => {
    const map = await wild.open(example('center-the-map-on-a-clicked-symbol'), { routes });
    const target = points[1];
    await map.feature({ layer: 'symbols', at: target }).click();
    await expect(map).toHaveView({ center: { lng: target.lng, lat: target.lat } });
  });

  test('the cursor turns into a pointer over a symbol', async ({ wild, page }) => {
    const map = await wild.open(example('center-the-map-on-a-clicked-symbol'), { routes });
    await map.feature({ layer: 'symbols', at: points[0] }).hover();
    await expect(page.locator('canvas.maplibregl-canvas')).toHaveCSS('cursor', 'pointer');
  });

  test(
    '3 symbols with no id AND no properties at all are 3 features (was 1: fixed in the library)',
    async ({ wild }) => {
      // FIXED IN THE LIBRARY: this test was written as `test.fixme` — id-less features with identical
      // properties used to collapse into ONE. The engine now splits same-key, id-less pieces by whether they touch on screen.
      const map = await wild.open(example('center-the-map-on-a-clicked-symbol'), { routes });
      await expect(map.features({ layer: 'symbols' })).toHaveFeatureCount(3);
    },
  );
});
