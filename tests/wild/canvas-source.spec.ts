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

  // Observe the actual transport budgets on the missing-engine probe and on its re-send after injection.
  // Holding the page busy for 5850ms of 8000ms left too little time for a loaded renderer to answer the real call. This
  // checks the regression directly: the re-sent wait must use half the time remaining AFTER injection,
  // while the real canvas map still returns the same never-idle diagnosis. No fixed stall is needed.
  test('the first call sizes its wait after the engine is injected, and the error still names the animated canvas', async ({ wild, page }) => {
    const map = await wild.open(example('add-a-canvas-source'), { routes: DEMOTILES, waitForIdle: false });
    await appLoaded(page);
    const sent: number[] = [];
    const evaluate = page.evaluate.bind(page);
    page.evaluate = (async (fn: any, arg: any) => {
      if (Array.isArray(arg) && arg[0] === 'waitForIdle') sent.push(arg[2][0]);
      return evaluate(fn, arg);
    }) as typeof page.evaluate;
    try {
      await expect(map.waitForIdle({ timeout: 4000 })).rejects.toThrow(ANIMATED_CANVAS);
    } finally {
      page.evaluate = evaluate;
    }
    expect(sent.length, 'a missing-engine probe followed by the real call').toBeGreaterThanOrEqual(2);
    const [probe, call] = sent;
    // The 4s deadline puts the initial wait below its 2s cap, so injection must shorten the re-send.
    // Compare the sent budgets directly: timestamps taken after sizing could include a scheduling pause.
    expect(call, 'the re-sent wait was recalculated after injection').toBeLessThan(probe);
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
