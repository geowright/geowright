import { brightBasemap } from './basemap';
import { example, expect, test } from './harness';

// MapLibre example "Variable label placement": one symbol layer, `text-variable-anchor` lets
// labels swap anchor (top/bottom/left/right) to stay on-screen and off their own icon, and the
// map keeps rotating (map.rotateTo(180, { duration: 10000 })) after load.
//
// FRICTION: `wild.open()`'s default `waitForIdle: true` uses the map handle's default action
// timeout (10 000ms) to wait for MapLibre's 'idle' event — which does not fire while
// `map.isMoving()`, true for the whole 10 000ms of this example's own `rotateTo(..., { duration:
// 10000 })`. The two 10s durations race: open() timed out outright in some runs ("map did not
// become idle") even though the map was in fact fine, just still turning. `options: { timeout:
// 15000 }` (a supported, public option — not a workaround) fixes it for specs that do not care
// about the animation; specs that DO want to observe the animation need `waitForIdle: false`.
const routes = brightBasemap([-77.04, 38.907]);

test.describe('wild: variable-label-placement', () => {
  test('all 7 places are on the map, each addressable by its unique description', async ({ wild }) => {
    const map = await wild.open(example('variable-label-placement'), { routes, options: { timeout: 15_000 } });
    await expect(map.features({ layer: 'poi-labels' })).toHaveFeatureCount(7);
    await expect(map).toHaveFeature({ layer: 'poi-labels', where: { description: "Ford's Theater" } });
    await expect(map).toHaveFeature({ layer: 'poi-labels', where: { icon: 'music' } }); // 3 match; existence only
  });

  // FRICTION: `wild.open()` defaults to `waitForIdle: true`, and MapLibre's 'idle' event does not
  // fire while `map.isMoving()` — which a running `rotateTo(..., { duration: 10000 })` keeps true
  // for its whole 10s. So the DEFAULT open() silently blocks for the full 10s animation and hands
  // back a map already settled at bearing 180; a test cannot observe "mid rotation" through it.
  // `{ waitForIdle: false }` is required to see the animation at all.
  test('the map keeps rotating after load: bearing does not settle, then stops exactly at 180', async ({ wild }) => {
    const map = await wild.open(example('variable-label-placement'), { routes, waitForIdle: false });
    const b1 = (await map.viewState()).bearing;
    await expect.poll(async () => (await map.viewState()).bearing, { timeout: 5000 }).not.toBe(b1);
    await map.waitForIdle({ timeout: 15000 });
    await expect(map).toHaveView({ bearing: 180 });
  });

  test('a place is clickable MID-rotation: the click itself waits out the animation and verifies at click time', async ({ wild }) => {
    const map = await wild.open(example('variable-label-placement'), { routes, waitForIdle: false });
    const theatre = map.feature({ layer: 'poi-labels', where: { description: "Ford's Theater" } });
    // No fixed sleep: actionability requires the map to not be moving (README "What an action waits
    // for"), so the click retries through the whole animation and only fires once it stops.
    await theatre.click({ timeout: 15_000 });
    const info = await theatre.info();
    expect(info.properties.description).toBe("Ford's Theater");
  });

  test('every place keeps an icon and a text label bound to it (one entity, not two)', async ({ wild }) => {
    const map = await wild.open(example('variable-label-placement'), { routes, options: { timeout: 15_000 } });
    const snap = await map.snapshot({ layers: ['poi-labels'], perLayer: 10 });
    expect(snap).toMatch(/\[poi-labels\] 7 symbol entities/);
    for (const name of ["Ford's Theater", 'The Gaslight', "Horrible Harry's", 'Bike Party', 'Rockabilly Rockstars', 'District Drum Tribe', 'Motown Memories']) {
      expect(snap).toContain(name);
    }
  });
});
