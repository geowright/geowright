import { block } from '../slow-machine';
import { DEMOTILES, example, expect, test } from './harness';

const ANIMATED_CANVAS = /did not become idle \(still moving, loading tiles, or repainting\) — source\(s\) canvas-source: an animated canvas \/ video source repaints the map on every frame\. Such a map NEVER becomes idle/;

/** The app's map has loaded its style and tiles (the example's own map object; geowright has not been injected yet). */
const appLoaded = (page: import('@playwright/test').Page) =>
  page.waitForFunction(() => {
    const m = (window as any).__geowright_maps?.main;
    return !!m && m.isStyleLoaded() && m.areTilesLoaded();
  });

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
    // an animated canvas source — the error names it (read from the style: independent of how fast frames come)
    await expect(map.waitForIdle({ timeout: 2500 })).rejects.toThrow(/did not become idle \(still moving, loading tiles, or repainting\) — source\(s\) canvas-source: an animated canvas \/ video source repaints the map on every frame\. Such a map NEVER becomes idle/);
  });

  // The first geowright call on a page also injects the engine (a ~400 KB evaluate): a probe, the injection, then the
  // call itself, re-sent. The in-page wait must be sized from the time left AFTER that. Sized before it (half the
  // timeout, at most 2 s), a first `waitForIdle` whose probe waited behind a busy main thread got a wait that could not
  // end before the deadline, and the error blamed a page that had answered twice: "the page did not answer … never
  // attempted" (a quiet 20x, one run in 20; the Playwright-floor CI, once). The numbers: the page is held busy for
  // 5850 ms of an 8000 ms timeout. A wait sized before the injection (2000 ms) cannot fit: 5850 + injection + 2000
  // > 8000 whenever the injection takes over 150 ms (measured: the first call takes 345–385 ms here, 505–545 ms at 4x
  // CPU throttling, of which the probe is 80–90 / 115–140 ms; the CI trace of the failure: 346 ms). Sized after it,
  // from what is left, the wait is half of ~1800 ms and the answer has the other half. That margin is bounded by the
  // 2 s cap of the in-page wait, whatever the timeout: under GEOWRIGHT_CPU_THROTTLE=4 it passed 5/5 alone, and failed
  // 1 in 3 with three throttled workers at load 10 (the probe came back 630 ms after the block, the injection took 565).
  test('the first call on a page whose main thread was busy: the wait is sized after the engine is injected, and the error still names the animated canvas', async ({ wild, page }) => {
    const map = await wild.open(example('add-a-canvas-source'), { routes: DEMOTILES, waitForIdle: false });
    await appLoaded(page);
    block(page, 5850);
    await expect(map.waitForIdle({ timeout: 8000 })).rejects.toThrow(ANIMATED_CANVAS);
  });

  // When the re-sent call itself is not answered, the error says what happened: the engine was missing, the page
  // answered the probe and the injection, and how much time the call itself had. The page here blocks INSIDE the
  // first in-page wait (the injected api is wrapped as it is assigned), for longer than the time that is left.
  test('a first call that the page does not answer: the error says the engine was injected, and how long the call itself had', async ({ wild, page }) => {
    await page.addInitScript(() => {
      let api: any;
      Object.defineProperty(window, '__geowright', {
        configurable: true,
        get: () => api,
        set: (v) => {
          const original = v.waitForIdle;
          v.waitForIdle = (...args: unknown[]) => {
            const end = Date.now() + 3000;
            while (Date.now() < end);
            return original(...args);
          };
          api = v;
        },
      });
    });
    const map = await wild.open(example('add-a-canvas-source'), { routes: DEMOTILES, waitForIdle: false });
    await appLoaded(page);
    block(page, 2000);
    const err = await map.waitForIdle({ timeout: 4000 }).then(() => null, (e: Error) => e);
    expect(err?.message).toMatch(/timed out after 4000ms — the page did not answer "waitForIdle" in the time that was left \(\d+ms: the engine was not in the page yet — the page answered that after \d+ms and its injection after another \d+ms; the call itself then had \d+ms; a busy main thread/);
    const [, budget, probe, injected, had] = /\((\d+)ms: the engine was not in the page yet — the page answered that after (\d+)ms and its injection after another (\d+)ms; the call itself then had (\d+)ms/.exec(err!.message)!.map(Number);
    expect(probe).toBeGreaterThanOrEqual(1900); // the probe waited behind the block
    expect(had).toBe(budget - probe - injected); // what was really left for the call
    expect(had).toBeLessThan(3000); // …and the blocked call could not answer in it
  });

  test('a first call whose injection is still under way at the deadline says so', async ({ wild, page }) => {
    await page.addInitScript(() => {
      let api: any;
      Object.defineProperty(window, '__geowright', {
        configurable: true,
        get: () => api,
        set: (v) => {
          const end = Date.now() + 3000; // the injection itself blocks
          while (Date.now() < end);
          api = v;
        },
      });
    });
    const map = await wild.open(example('add-a-canvas-source'), { routes: DEMOTILES, waitForIdle: false });
    await appLoaded(page);
    block(page, 1000);
    const err = await map.waitForIdle({ timeout: 2500 }).then(() => null, (e: Error) => e);
    expect(err?.message).toMatch(/the page did not answer "waitForIdle" in the time that was left \(\d+ms: the engine was not in the page yet — the page answered that after \d+ms, and its injection was still under way at the deadline; a busy main thread/);
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

  // FIXED IN THE LIBRARY: written as test.fixme — "a team wanting a pixel-content regression test for a
  // raster / canvas / image layer has no geowright API for it". `toHaveLayerPixels` is the feature-less sibling of
  // toBeVisibleOnMap: do the canvas pixels at a location change when the layer is not drawn?
  test('the canvas layer paints pixels inside its quad and nothing outside it', async ({ wild }) => {
    const map = await wild.open(example('add-a-canvas-source'), { routes: DEMOTILES, waitForIdle: false });
    // The example draws five thin 20px circle OUTLINES bouncing inside its 400x400 canvas: any window smaller than the
    // quad can be empty (48px failed 3 of ~6 repeats in a 20x; 100px — a 201px square, a quarter of the quad — still
    // failed 1 in 40 on a quiet machine). The quad is ~400px wide at zoom 5, so probe all of it (a 401px square around
    // its centre): the circles never leave the canvas, so there are always five in it.
    await expect(map).toHaveLayerPixels('canvas-layer', { at: { lng: 95.9, lat: 17.8 }, radiusPx: 200 });
    await expect(map).not.toHaveLayerPixels('canvas-layer', { at: { lng: 104, lat: 17.7 } }); // east of the quad
  });
});
