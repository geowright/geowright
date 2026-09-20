import { DEMOTILES, example, expect, test } from './harness';

// MapLibre example "Animate a point": a circle layer whose GeoJSON source is replaced on every
// requestAnimationFrame (setData), forever — the map never becomes idle.
// Almost always `unstable`. Rarely (≈1 in 20 under heavy contention) `ambiguous`: the source is re-set every frame
// and for an instant the dot is rendered from two tile generations, 30px apart — two id-less, property-identical
// pieces that do not touch. The engine asks the source data ("one feature? then it is one") and that removes most
// of it, not all: recorded as an open issue in the design notes. Either way the action refuses; it never mis-clicks.
// Since an earlier phase an action's timeout is wall-clock: on an overloaded machine the refusal can also be "the page did not
// answer in the time that was left" — equally true, equally not a click.
const REFUSED = /unstable: feature position changed between two animation frames|ambiguous: strict mode violation: query resolved to 2 features: point \{\}|the page did not answer "actionPoint" in the time that was left/;

test.describe('wild: animate-a-point', () => {
  test('the point is on the map and never becomes idle (waitForIdle must be opted out)', async ({ wild }) => {
    const map = await wild.open(example('animate-a-point'), { routes: DEMOTILES, waitForIdle: false });
    await expect(map).toHaveFeature({ layer: 'point' });
    // this is the point of the example: the animation must NOT stop. A regression that breaks the
    // requestAnimationFrame loop would make the map go idle - catch that.
    // …and the error says WHY, instead of leaving the reader to guess that the app is slow
    // (the second alternative is what a starved page gives: fewer than two data replacements were SEEN inside the wait —
    //  the library then says only what it knows, not what it guesses)
    await expect(map.waitForIdle({ timeout: 2500 })).rejects.toThrow(/did not become idle \(still moving, loading tiles, or repainting\) — (the app keeps replacing the data of source\(s\) point \(\d+ times in \d+ms\) — setData in a requestAnimationFrame loop or a timer\. Such a map NEVER becomes idle|source\(s\) point have not finished loading)/);
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

  // Click only. hover({ moving: 'allow' }) was here too and was REMOVED, not retried into passing: on this page (a
  // full-screen basemap in software GL, ~14 frames/s alone, 2-3 under five workers) a mousemove is delivered on a
  // frame boundary, so its lateness jitters by whole frames — more than the ~175ms this 10px dot spends under any
  // pixel. Measured under 5-worker contention: click 30/30, hover 14/30. Hover on a moving feature is covered on the
  // light demo page (tests/moving.spec.ts), where a frame is short compared with the target's dwell time.
  test("{ moving: 'allow' }: a click on the perpetually moving point lands ON it or not at all — verified when the real event arrives", async ({ wild, page }) => {
    test.setTimeout(90_000);
    const map = await wild.open(example('animate-a-point'), { routes: DEMOTILES, waitForIdle: false });
    await expect(map).toHaveFeature({ layer: 'point' }, { timeout: 15_000 });
    // The example has no click handler of its own. Observing through MapLibre's public event API changes nothing
    // about the app or the input: the clicks below are real mouse events at real pixels.
    await page.evaluate(() => {
      const m = (window as any).__geowright_maps.main;
      (window as any).__seen = { onPoint: 0, anywhere: 0 };
      m.on('click', () => (window as any).__seen.anywhere++);
      m.on('click', 'point', () => (window as any).__seen.onPoint++);
    });
    // What is asserted is the CONTRACT, which does not depend on how fast this machine is: whatever reaches the app is
    // ON the point, exactly once — or nothing reaches it at all and the action says why. Whether the click LANDS depends
    // on frame time vs. the ~175ms this dot spends under a pixel: alone or with this spec on five workers it lands
    // (30/30); in the middle of the full suite on a loaded machine it timed out once in three runs, every one of its
    // presses swallowed. A success-only assertion here would be a flake by construction, so it is not made.
    const outcome = await map.feature({ layer: 'point' }).click({ moving: 'allow', timeout: 30_000 }).then(() => 'clicked', (e: Error) => e.message);
    const seen = await page.evaluate(() => (window as any).__seen);
    if (outcome === 'clicked') expect(seen).toMatchObject({ onPoint: 1, anywhere: 1 });
    else {
      expect(seen).toMatchObject({ onPoint: 0, anywhere: 0 });
      expect(outcome).toMatch(/click was intercepted and cancelled: target was no longer under the pointer|the page did not answer "actionPoint"/);
    }
  });

  test('the source holds a bare GeoJSON geometry (no Feature wrapper): the library can still ask it about the point', async ({ wild }) => {
    // Until an earlier phase a bare geometry read as "no features", so identity could never be learnt from this source —
    // the cause of the rare `ambiguous` above. `from: 'data'` proves the source answered.
    const map = await wild.open(example('animate-a-point'), { routes: DEMOTILES, waitForIdle: false });
    await expect(map).toHaveFeature({ layer: 'point' }, { timeout: 15_000 });
    const g = await map._call<{ ok: boolean; from?: string; geometry?: { type: string } }>('geometry', { layer: 'point' });
    expect(g).toMatchObject({ ok: true, from: 'data', geometry: { type: 'Point' } });
  });
});
