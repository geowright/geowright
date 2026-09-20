import { DEMOTILES, example, expect, test } from './harness';

// MapLibre example "Animate a point": a circle layer whose GeoJSON source is replaced on every
// requestAnimationFrame (setData), forever — the map never becomes idle.
// Almost always `unstable`. Rarely (≈1 in 20 under heavy contention) `ambiguous`: the source is re-set every frame
// and for an instant the dot is rendered from two tile generations, 30px apart — two id-less, property-identical
// pieces that do not touch. The engine asks the source data ("one feature? then it is one") and that removes most
// of it, not all: recorded as an open issue in the design notes. Either way the action refuses; it never mis-clicks.
const REFUSED = /unstable: feature position changed between two animation frames|ambiguous: strict mode violation: query resolved to 2 features: point \{\}/;

test.describe('wild: animate-a-point', () => {
  test('the point is on the map and never becomes idle (waitForIdle must be opted out)', async ({ wild }) => {
    const map = await wild.open(example('animate-a-point'), { routes: DEMOTILES, waitForIdle: false });
    await expect(map).toHaveFeature({ layer: 'point' });
    // this is the point of the example: the animation must NOT stop. A regression that breaks the
    // requestAnimationFrame loop would make the map go idle - catch that.
    await expect(map.waitForIdle({ timeout: 1500 })).rejects.toThrow(/did not become idle \(still moving, loading tiles, or repainting\)/);
  });

  test('the point stays on the radius-20 circle around the origin at any sampled instant', async ({ wild }) => {
    const map = await wild.open(example('animate-a-point'), { routes: DEMOTILES, waitForIdle: false });
    const point = map.feature({ layer: 'point' });
    for (let i = 0; i < 3; i++) {
      const { lngLat } = await point.info();
      // geojson-source geometry read back through tile quantization, not the exact float: allow sub-pixel slack.
      expect(Math.hypot(lngLat!.lng, lngLat!.lat)).toBeCloseTo(20, 1);
    }
  });

  test('the point actually moves between reads (it is not a static feature that merely claims to animate)', async ({ wild }) => {
    const map = await wild.open(example('animate-a-point'), { routes: DEMOTILES, waitForIdle: false });
    const point = map.feature({ layer: 'point' });
    const first = (await point.info()).lngLat!;
    await expect.poll(async () => (await point.info()).lngLat!.lng).not.toBeCloseTo(first.lng, 3);
  });

  test('clicking or hovering the perpetually moving point never succeeds, and the error names the real cause', async ({ wild }) => {
    // The action's own `timeout` bounds the retry deadline, but not necessarily wall-clock time (a
    // single in-flight attempt cannot be aborted): on a loaded shared machine we measured a
    // `{ timeout: 2000 }` click rejecting after up to ~33s of real time — see FRICTION LOG. Generous
    // test-level budget so that contention on THIS machine never flakes the (always-true) outcome.
    test.setTimeout(90_000);
    const map = await wild.open(example('animate-a-point'), { routes: DEMOTILES, waitForIdle: false });
    await expect(map).toHaveFeature({ layer: 'point' }, { timeout: 15_000 });
    await expect(map.feature({ layer: 'point' }).click({ timeout: 5000 })).rejects.toThrow(
      REFUSED,
    );
    await expect(map.feature({ layer: 'point' }).hover({ timeout: 5000 })).rejects.toThrow(
      REFUSED,
    );
  });
});
