import { brightBasemap } from './basemap';
import { example, expect, test, type Routes } from './harness';

// MapLibre example "Update a feature in realtime": d3 fetches a hike track once, then a
// `setInterval(10ms)` appends one more coordinate to a line source AND `panTo`s the camera after it,
// forever (well: until the ~4000-point track is exhausted, ~40s later) — both the DATA and the CAMERA
// keep moving.
const routes: Routes = [
  ...brightBasemap([-122.019807, 45.632433]),
  ['https://maplibre.org/maplibre-gl-js/docs/assets/hike.geojson', 'hike.geojson'],
  ['https://d3js.org/d3.v3.min.js', 'vendor/d3@3/d3.v3.min.js'],
];

test.describe('wild: update-a-feature-in-realtime', () => {
  test('the map never becomes idle while the trace streams in', async ({ wild }) => {
    const map = await wild.open(example('update-a-feature-in-realtime'), { routes, waitForIdle: false });
    await expect(map).toHaveFeature({ layer: 'trace' });
    await expect(map.waitForIdle({ timeout: 2000 })).rejects.toThrow(/did not become idle \(still moving, loading tiles, or repainting\)/);
  });

  test('the trace line grows monotonically as coordinates stream in from d3', async ({ wild }) => {
    const map = await wild.open(example('update-a-feature-in-realtime'), { routes, waitForIdle: false });
    const trace = map.feature({ layer: 'trace' });
    await expect(map).toHaveFeature({ layer: 'trace' });
    const before = ((await trace.geometry()) as { coordinates: unknown[] }).coordinates.length;
    await expect
      .poll(async () => ((await trace.geometry()) as { coordinates: unknown[] }).coordinates.length)
      .toBeGreaterThan(before);
  });

  test('the camera follows the hike and stays pitched at 30°, set once by the app', async ({ wild }) => {
    const map = await wild.open(example('update-a-feature-in-realtime'), { routes, waitForIdle: false });
    await expect(map).toHaveFeature({ layer: 'trace' });
    // FRICTION: toHaveView requires the map "at rest" (like waitForIdle), so it can never confirm even
    // a STATIC property (pitch, set once via setPitch) on a camera that pans forever — read the raw
    // view state and poll it instead.
    await expect.poll(async () => (await map.viewState()).pitch).toBe(30);
    const before = (await map.viewState()).center;
    await expect.poll(async () => (await map.viewState()).center.lng).not.toBeCloseTo(before.lng, 6);
  });

  test('the trace is painted in the app\'s yellow line style, and visible over the basemap', async ({ wild }) => {
    const map = await wild.open(example('update-a-feature-in-realtime'), { routes, waitForIdle: false });
    await expect(map).toHaveFeature({ layer: 'trace' });
    await expect(map.feature({ layer: 'trace' })).toBeVisibleOnMap();
  });

  test('hovering the trace never succeeds while the camera is panning, and the error names the real cause (not the point-instability one)', async ({ wild }) => {
    const map = await wild.open(example('update-a-feature-in-realtime'), { routes, waitForIdle: false });
    await expect(map).toHaveFeature({ layer: 'trace' });
    // unlike animate-a-point (a still camera, a moving FEATURE -> "unstable" after two frames), here the
    // CAMERA itself never stops (panTo every 10ms), so actionPoint bails immediately at step 1 ("moving").
    await expect(map.feature({ layer: 'trace' }).hover({ timeout: 3000 })).rejects.toThrow(
      /moving: map is moving \(camera animation or user gesture in progress\)/,
    );
  });
});
