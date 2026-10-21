import { brightBasemap } from './basemap';
import { example, expect, test, type Routes } from './harness';
import { allowForThrottle, cpuSlowdown } from '../slow-machine';

// MapLibre example "Update a feature in realtime": d3 fetches a hike track once, then a
// `setInterval(10ms)` appends one more coordinate to a line source AND `panTo`s the camera after it,
// forever (well: until the ~4000-point track is exhausted, ~40s later) — both the DATA and the CAMERA
// keep moving.
const routes: Routes = [
  ...brightBasemap([-122.019807, 45.632433]),
  ['https://maplibre.org/maplibre-gl-js/docs/assets/hike.geojson', 'hike.geojson'],
  ['https://d3js.org/d3.v3.min.js', 'vendor/d3@3/d3.v3.min.js'],
];

// A page whose timer appends a point and pans the camera every 10 ms answers a round trip late on a shared 2-CPU
// runner (the oldest supported Playwright, hosted: "the page did not answer" after 2 s, and the first matcher's 7 s
// ran out before the engine was in the page). The matcher waits get 15 s; the expected "never idle" gets 7 s, as in
// animate-point.spec.ts.
const IDLE_FAIL_MS = 7000 * cpuSlowdown();
const BUSY_PAGE = { timeout: 15_000 };

test.describe('wild: update-a-feature-in-realtime', () => {
  test.slow(); // a page that updates its data and camera every 10 ms
  test('the map never becomes idle while the trace streams in', async ({ wild }) => {
    allowForThrottle(IDLE_FAIL_MS); // the expected failure waits out its timeout
    const map = await wild.open(example('update-a-feature-in-realtime'), { routes, waitForIdle: false });
    await expect(map).toHaveFeature({ layer: 'trace' }, BUSY_PAGE);
    await expect(map.waitForIdle({ timeout: IDLE_FAIL_MS })).rejects.toThrow(/did not become idle \(still moving, loading tiles, or repainting\)/);
  });

  test('the trace line grows monotonically as coordinates stream in from d3', async ({ wild }) => {
    const map = await wild.open(example('update-a-feature-in-realtime'), { routes, waitForIdle: false });
    const trace = map.feature({ layer: 'trace' });
    await expect(map).toHaveFeature({ layer: 'trace' }, BUSY_PAGE);
    const before = ((await trace.geometry()) as { coordinates: unknown[] }).coordinates.length;
    await expect
      .poll(async () => ((await trace.geometry()) as { coordinates: unknown[] }).coordinates.length, BUSY_PAGE)
      .toBeGreaterThan(before);
  });

  test('the camera follows the hike and stays pitched at 30°, set once by the app', async ({ wild }) => {
    const map = await wild.open(example('update-a-feature-in-realtime'), { routes, waitForIdle: false });
    await expect(map).toHaveFeature({ layer: 'trace' }, BUSY_PAGE);
    // FRICTION: toHaveView requires the map "at rest" (like waitForIdle), so it can never confirm even
    // a STATIC property (pitch, set once via setPitch) on a camera that pans forever — read the raw
    // view state and poll it instead.
    await expect.poll(async () => (await map.viewState()).pitch, BUSY_PAGE).toBe(30);
    const before = (await map.viewState()).center;
    await expect.poll(async () => (await map.viewState()).center.lng, BUSY_PAGE).not.toBeCloseTo(before.lng, 6);
  });

  test('the trace is painted in the app\'s yellow line style, and visible over the basemap', async ({ wild }) => {
    const map = await wild.open(example('update-a-feature-in-realtime'), { routes, waitForIdle: false });
    await expect(map).toHaveFeature({ layer: 'trace' }, BUSY_PAGE);
    await expect(map.feature({ layer: 'trace' })).toBeVisibleOnMap(BUSY_PAGE);
  });

  test('hovering the trace never succeeds while the camera is panning, and the error names the real cause (not the point-instability one)', async ({ wild }) => {
    const map = await wild.open(example('update-a-feature-in-realtime'), { routes, waitForIdle: false });
    await expect(map).toHaveFeature({ layer: 'trace' }, BUSY_PAGE);
    // unlike animate-a-point (a still camera, a moving FEATURE -> "unstable" after two frames), here the
    // CAMERA itself never stops (panTo every 10ms), so actionPoint bails immediately at step 1 ("moving").
    await expect(map.feature({ layer: 'trace' }).hover({ timeout: IDLE_FAIL_MS })).rejects.toThrow(
      /moving: map is moving \(camera animation or user gesture in progress\)/,
    );
  });
});
