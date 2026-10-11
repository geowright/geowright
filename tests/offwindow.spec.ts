import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { FAIL_FAST_MS } from './slow-machine';
import { holds } from '../src/inpage/engine';

/**
 * A map taller than the browser window. Real input reaches only what is inside the WINDOW: a location whose surface
 * pixel is below it is on the map, but no pointer can get there. Feature actions have always said so ("outside the
 * browser window"); the location actions (clickAt, clientPoint, the destination of dragTo / dragBy) checked only that
 * the pixel was inside the map surface, and pressed or released where the app never got the event.
 */
async function tallMap(page: Page) {
  await page.evaluate(() => {
    const el = document.getElementById('map')!;
    el.style.bottom = 'auto';
    el.style.height = '1400px';
    const m = (window as any).__geowright_maps.main;
    m.resize();
    (window as any).__clicks = [];
    m.on('click', (e: any) => (window as any).__clicks.push([e.point.x, e.point.y]));
  });
}

/** A location whose surface pixel is at (480, 1000): inside the 1400px map, below the 720px window. */
function belowTheWindow(page: Page) {
  return page.evaluate(() => {
    const ll = (window as any).__geowright_maps.main.unproject([480, 1000]);
    return { lng: ll.lng as number, lat: ll.lat as number };
  });
}

const OFF_WINDOW = 'outside the browser window';

test.describe('a location below the window (the map is taller than it)', () => {
  test('clickAt says it is outside the window, not "covered by a DOM element", and clicks nothing', async ({ map, page }) => {
    await tallMap(page);
    await map.waitForIdle();
    const at = await belowTheWindow(page);
    const err = await map.clickAt(at, { timeout: FAIL_FAST_MS }).then(() => null, (e: Error) => e);
    expect(err?.message).toContain(OFF_WINDOW);
    expect(err?.message).not.toContain('covered by a DOM element');
    expect(await page.evaluate(() => (window as any).__clicks)).toEqual([]);
  });

  test('clickAt({ force: true }) refuses too: force skips the cover check, not reachability', async ({ map, page }) => {
    await tallMap(page);
    await map.waitForIdle();
    const at = await belowTheWindow(page);
    const err = await map.clickAt(at, { force: true, timeout: FAIL_FAST_MS }).then(() => null, (e: Error) => e);
    expect(err?.message).toContain(OFF_WINDOW);
    expect(await page.evaluate(() => (window as any).__clicks)).toEqual([]);
  });

  test('map.clientPoint() does not answer a pixel outside the window', async ({ map, page }) => {
    await tallMap(page);
    await map.waitForIdle();
    const at = await belowTheWindow(page);
    const err = await map.clientPoint(at, { timeout: FAIL_FAST_MS }).then(() => null, (e: Error) => e);
    expect(err?.message).toContain(OFF_WINDOW);
  });

  test('dragTo a destination below the window refuses, and sends no press', async ({ map, page }) => {
    await tallMap(page);
    // MapLibre's "drag a point" example, in short: press on the point, move, release -> setData at the release
    await page.evaluate(() => {
      const m = (window as any).__geowright_maps.main;
      const c = m.unproject([480, 400]);
      const fc = (lng: number, lat: number) => ({ type: 'FeatureCollection', features: [{ type: 'Feature', id: 1, properties: { name: 'pin' }, geometry: { type: 'Point', coordinates: [lng, lat] } }] });
      m.addSource('drag', { type: 'geojson', data: fc(c.lng, c.lat) });
      m.addLayer({ id: 'drag', type: 'circle', source: 'drag', paint: { 'circle-radius': 10, 'circle-color': '#e0a' } });
      const w = window as any;
      w.__presses = 0;
      m.on('mousedown', 'drag', (e: any) => {
        w.__presses++;
        e.preventDefault();
        const move = (ev: any) => m.getSource('drag').setData(fc(ev.lngLat.lng, ev.lngLat.lat));
        m.on('mousemove', move);
        m.once('mouseup', () => m.off('mousemove', move));
      });
    });
    await map.waitForIdle();
    const to = await belowTheWindow(page);
    const err = await map.feature({ layer: 'drag' }).dragTo(to, { timeout: FAIL_FAST_MS }).then(() => null, (e: Error) => e);
    expect(err?.message).toContain(OFF_WINDOW);
    expect(await page.evaluate(() => (window as any).__presses)).toBe(0);
  });

  test('dragBy to a point below the window refuses, and sends no press', async ({ map, page }) => {
    await tallMap(page);
    await page.evaluate(() => {
      const m = (window as any).__geowright_maps.main;
      const c = m.unproject([480, 400]);
      m.addSource('drag', { type: 'geojson', data: { type: 'Feature', id: 1, properties: {}, geometry: { type: 'Point', coordinates: [c.lng, c.lat] } } });
      m.addLayer({ id: 'drag', type: 'circle', source: 'drag', paint: { 'circle-radius': 10, 'circle-color': '#e0a' } });
      (window as any).__presses = 0;
      m.on('mousedown', 'drag', () => (window as any).__presses++);
    });
    await map.waitForIdle();
    const from = await page.evaluate(() => (window as any).__geowright_maps.main.unproject([480, 400]));
    const to = await belowTheWindow(page);
    const err = await map.feature({ layer: 'drag' }).dragBy({ dLng: to.lng - from.lng, dLat: to.lat - from.lat }, { timeout: FAIL_FAST_MS }).then(() => null, (e: Error) => e);
    expect(err?.message).toContain(OFF_WINDOW);
    expect(await page.evaluate(() => (window as any).__presses)).toBe(0);
  });

  test('clickAt with autoPan moves the camera so that the location is inside the window, then clicks it', async ({ map, page }) => {
    await tallMap(page);
    await map.waitForIdle();
    const at = await belowTheWindow(page);
    await map.clickAt(at, { autoPan: true });
    const clicks: number[][] = await page.evaluate(() => (window as any).__clicks);
    expect(clicks).toHaveLength(1);
    const clicked = await page.evaluate(([x, y]) => (window as any).__geowright_maps.main.unproject([x, y]), clicks[0]);
    expect(Math.abs(clicked.lng - at.lng)).toBeLessThan(0.001);
    expect(Math.abs(clicked.lat - at.lat)).toBeLessThan(0.001);
  });

  // A map more than twice the window's height: its centre is itself below the window, so no pan brings the location in.
  // autoPan pans once (as for a feature), and the failure says why, not "panned to location".
  test('clickAt with autoPan on a map whose centre is below the window pans once, and says the location is outside it', async ({ map, page }) => {
    await page.evaluate(() => {
      const el = document.getElementById('map')!;
      el.style.bottom = 'auto';
      el.style.height = '1600px';
      const m = (window as any).__geowright_maps.main;
      m.resize();
      (window as any).__clicks = [];
      m.on('click', (e: any) => (window as any).__clicks.push([e.point.x, e.point.y]));
    });
    await map.waitForIdle(); // (the container's own resize observer resizes the map once more)
    await page.evaluate(() => {
      (window as any).__pans = 0;
      (window as any).__geowright_maps.main.on('movestart', () => (window as any).__pans++);
    });
    const at = await belowTheWindow(page);
    const err = await map.clickAt(at, { autoPan: true, timeout: FAIL_FAST_MS }).then(() => null, (e: Error) => e);
    expect(err?.message.split('\n')[0]).toContain(OFF_WINDOW);
    expect(await page.evaluate(() => ({ clicks: (window as any).__clicks.length, pans: (window as any).__pans }))).toEqual({ clicks: 0, pans: 1 });
  });

  test('the snapshot says a feature below the window is outside it, not covered by DOM', async ({ map, page }) => {
    await tallMap(page);
    await page.evaluate(() => {
      const m = (window as any).__geowright_maps.main;
      const c = m.unproject([480, 1000]);
      m.addSource('low', { type: 'geojson', data: { type: 'Feature', id: 7, properties: { name: 'below the window' }, geometry: { type: 'Point', coordinates: [c.lng, c.lat] } } });
      m.addLayer({ id: 'low', type: 'circle', source: 'low', paint: { 'circle-radius': 10, 'circle-color': '#e0a' } });
    });
    await map.waitForIdle();
    const line = (await map.snapshot({ layers: ['low'] })).split('\n').find((l) => l.includes('below the window'));
    expect(line).toContain('outside-window');
    expect(line).not.toContain('covered-by-dom');
  });

  test('a location inside the window on the same tall map is clicked where it is', async ({ map, page }) => {
    await tallMap(page);
    await map.waitForIdle();
    const at = await page.evaluate(() => {
      const ll = (window as any).__geowright_maps.main.unproject([480, 300]);
      return { lng: ll.lng as number, lat: ll.lat as number };
    });
    await map.clickAt(at);
    const clicks: number[][] = await page.evaluate(() => (window as any).__clicks);
    expect(clicks).toHaveLength(1);
    expect(Math.abs(clicks[0][0] - 480)).toBeLessThanOrEqual(1);
    expect(Math.abs(clicks[0][1] - 300)).toBeLessThanOrEqual(1);
  });
});

/**
 * A map further down a page that scrolls, inside a panel that scrolls too, with both at the top. An action scrolls the
 * map into view, as a Locator does (README, item 0 of "What an action waits for"). An assertion must leave the page where
 * it found it: an app with scroll-driven state (a header that hides on scroll, lazy loading, the next screenshot) would
 * otherwise depend on whether the assertion ran. Playwright's own assertions do not scroll.
 */
async function belowTheFold(page: Page) {
  await page.evaluate(() => {
    document.documentElement.style.height = 'auto';
    document.body.style.height = 'auto';
    const el = document.getElementById('map')!;
    const panel = document.createElement('div');
    panel.id = 'panel';
    panel.style.cssText = 'position:relative;margin:1500px 0 0 320px;width:980px;height:720px;overflow:auto';
    el.parentElement!.insertBefore(panel, el);
    const spacer = document.createElement('div');
    spacer.style.height = '800px';
    panel.append(spacer, el);
    el.style.cssText = 'position:relative;left:auto;right:auto;top:auto;bottom:auto;width:960px;height:720px';
    (window as any).__geowright_maps.main.resize();
    window.scrollTo(0, 0);
    panel.scrollTop = 0;
  });
  await expect(page.locator('canvas.maplibregl-canvas')).not.toBeInViewport(); // premise: no pixel of the map is in the window
}

const scrolled = (page: Page) => page.evaluate(() => ({ page: scrollY, panel: document.getElementById('panel')!.scrollTop }));
const failure = (assertion: Promise<unknown>) => assertion.then(() => 'passed', (e: Error) => e.message.split('\n')[0]);

test.describe('a map below the fold, in a scrolling panel: assertions leave the page where it was', () => {
  test('toBeVisibleOnMap looks at the map in the window (elementFromPoint sees nothing outside it), then scrolls back', async ({ map, page }) => {
    await belowTheFold(page);
    await map.waitForIdle();
    await expect(map.feature({ layer: 'alerts', id: 1 })).toBeVisibleOnMap(); // a verdict: the probe looked with the map in view
    expect(await scrolled(page)).toEqual({ page: 0, panel: 0 });
  });

  test('a failing assertion still attaches a picture of the map, then scrolls back', async ({ map, page }, testInfo) => {
    await belowTheFold(page);
    await map.waitForIdle();
    expect(await failure(expect(map.feature({ layer: 'alerts', id: 1 })).not.toBeVisibleOnMap({ timeout: FAIL_FAST_MS }))).toContain('.not.toBeVisibleOnMap()');
    expect(await failure(expect(map).not.toHaveLayerPixels('alerts', { at: { lng: 34.77, lat: 32.085 }, timeout: FAIL_FAST_MS }))).toContain('.not.toHaveLayerPixels(');
    expect(await failure(expect(map).toHaveFeature({ layer: 'alerts', id: 99 }, { timeout: FAIL_FAST_MS }))).toContain('.toHaveFeature(');
    const shots = testInfo.attachments.filter((a) => a.contentType === 'image/png');
    expect(shots.map((a) => a.name)).toEqual(['map screenshot — toBeVisibleOnMap', 'map screenshot — toHaveLayerPixels', 'map screenshot — toHaveFeature']);
    for (const s of shots) expect(s.body!.length).toBeGreaterThan(5_000);
    expect(await scrolled(page)).toEqual({ page: 0, panel: 0 });
    await expect(page.locator('[id^="geowright-marks-"]')).toHaveCount(0);
  });

  // The look's scroll is instant, and an instant scroll ends a smooth one the app has under way on the same scroller (a
  // "show on map" button that scrolls to the map): put back, the page stayed where the look had found it, mid-way, with the
  // map still below the window, and the app's scroll never reached its end. While the page is scrolling, the look takes it
  // as it is.
  test("the app's own smooth scroll toward the map: an assertion's look does not cut it short", async ({ map, page }) => {
    await page.evaluate(() => {
      document.documentElement.style.height = 'auto';
      document.body.style.height = 'auto';
      const el = document.getElementById('map')!;
      el.style.cssText = 'position:relative;left:320px;right:auto;top:auto;bottom:auto;width:960px;height:720px';
      el.before(Object.assign(document.createElement('div'), { style: 'height:1500px' }));
      el.after(Object.assign(document.createElement('div'), { style: 'height:2000px' }));
      (window as any).__geowright_maps.main.resize();
      window.scrollTo(0, 0);
    });
    await map.waitForIdle();
    const startedAt = await page.evaluate(async () => {
      window.scrollTo({ top: 1400, behavior: 'smooth' }); // the map's top 100 px below the window's
      for (let i = 0; i < 120 && scrollY === 0; i++) await new Promise((r) => requestAnimationFrame(r));
      const at = scrollY;
      await (window as any).__geowright.pixelProbe('main', { layer: 'alerts', id: 1, visible: 'any' });
      return at;
    });
    expect(startedAt > 0 && startedAt < 1400, `premise: the look ran while the scroll was under way (at ${startedAt})`).toBe(true);
    await expect.poll(() => page.evaluate(() => scrollY), "the app's scroll reaches its end").toBe(1400);
    await expect(map.feature({ layer: 'alerts', id: 1 })).toBeVisibleOnMap();
    expect(await page.evaluate(() => scrollY), 'and an assertion after it leaves the page there').toBe(1400);
  });
});

/**
 * A dashboard layout: the 960x720 map inside a 300px-high panel that scrolls (overflow: auto). The part of the map below
 * the panel's edge is not on the page until the panel is scrolled; nothing covers it (`elementFromPoint` there gives what
 * is beyond the panel: the <body>). That read as "covered by DOM", and `.not.toBeVisibleOnMap()` passed on a feature a user
 * sees once the panel is scrolled. It is clipped: no verdict either way, and an action says so.
 */
test.describe('a map partly scrolled out of a panel that clips it', () => {
  test('a feature in the clipped part: no verdict either way, a click says it is clipped; scrolled into the panel, visible', async ({ map, page }) => {
    await page.evaluate(() => {
      const el = document.getElementById('map')!;
      const panel = document.createElement('div');
      panel.id = 'panel';
      panel.style.cssText = 'position:absolute;left:320px;top:0;width:980px;height:300px;overflow:auto';
      el.parentElement!.insertBefore(panel, el);
      panel.appendChild(el);
      el.style.cssText = 'position:relative;left:auto;right:auto;top:auto;bottom:auto;width:960px;height:720px';
      const m = (window as any).__geowright_maps.main;
      m.resize();
      const at = (x: number, y: number) => {
        const c = m.unproject([x, y]);
        return [c.lng, c.lat];
      };
      const dot = (id: number, y: number) => ({ type: 'Feature', id, properties: {}, geometry: { type: 'Point', coordinates: at(480, y) } });
      m.addSource('dots', { type: 'geojson', data: { type: 'FeatureCollection', features: [dot(1, 150), dot(2, 500)] } });
      m.addLayer({ id: 'dots', type: 'circle', source: 'dots', paint: { 'circle-radius': 10, 'circle-color': '#e0a' } });
    });
    await map.waitForIdle();
    await expect(map.feature({ layer: 'dots', id: 1 }), 'control: a dot in the part the panel shows').toBeVisibleOnMap();
    await expect(map, 'premise: the other dot is drawn, 200 px below the panel').toHaveFeature({ layer: 'dots', id: 2 });
    const clipped = map.feature({ layer: 'dots', id: 2 });
    const message = (p: Promise<unknown>) => p.then(() => 'passed', (e: Error) => e.message);
    const NO_VERDICT = /no verdict: pixels: nowhere to probe — offscreen: .*clipped by <div#panel>/;
    expect(await message(expect(clipped).not.toBeVisibleOnMap({ timeout: FAIL_FAST_MS })), '.not.toBeVisibleOnMap').toMatch(NO_VERDICT);
    expect(await message(expect(clipped).toBeVisibleOnMap({ timeout: FAIL_FAST_MS })), 'toBeVisibleOnMap').toMatch(NO_VERDICT);
    expect(await message(clipped.click({ timeout: FAIL_FAST_MS })), 'click()').toMatch(/offscreen: .*clipped by <div#panel>/);
    // what a user does: scroll the panel
    await page.evaluate(() => (document.getElementById('panel')!.scrollTop = 300));
    await expect(clipped).toBeVisibleOnMap();
  });
});

/**
 * Only an ancestor whose overflow clips makes a part of the map "clipped". Where `elementFromPoint` finds the page itself for
 * another reason, nothing is drawn of the map there, or something covers it: a map hidden with `visibility: hidden` (the hit
 * test skips it; the demo's map is a child of the <body>), a backdrop the page draws as its <body>'s own ::after. A user
 * sees no feature there: "not visible", as it was before the clipping rule. Read as clipped, `.not.toBeVisibleOnMap()` failed
 * with no verdict and a click said "clipped by <body>: scrolled out of view inside it".
 */
test.describe('a map the page hides or covers is not clipped', () => {
  for (const c of [
    { how: 'hidden with visibility: hidden', css: '#map { visibility: hidden !important }' },
    { how: "covered by the <body>'s own ::after backdrop", css: 'body::after { content: ""; position: fixed; inset: 0; z-index: 100000; background: rgba(0, 0, 0, 0.5) }' },
  ]) {
    test(`a map ${c.how}: not visible, and a click names what covers it`, async ({ map, page }) => {
      const dot = map.feature({ layer: 'alerts', id: 1 });
      await expect(dot, 'control: visible before').toBeVisibleOnMap();
      await page.addStyleTag({ content: c.css });
      await expect(dot).not.toBeVisibleOnMap();
      const message = await dot.click({ timeout: FAIL_FAST_MS }).then(() => 'passed', (e: Error) => e.message);
      expect(message).toMatch(/dom-covered: every candidate point is covered by DOM element <body>/);
      expect(message).not.toMatch(/clipped/);
    });
  }
});

/**
 * An ancestor whose overflow clips clips only what its box contains: a map positioned out of it is not clipped by it. Two
 * layouts: MapLibre's usual full-page CSS (the demo's absolutely positioned #map) inside a static wrapper with
 * `overflow: hidden`, which is 0 px tall since its only child is out of flow; a `position: fixed` map inside a scrolling
 * panel. Under a modal such a map is covered, not clipped, though every pixel of it is outside the wrapper's box: the hit
 * test still finds the map's canvas there, under the modal, which it does not where an overflow clip takes the map away.
 * Read as clipped, `.not.toBeVisibleOnMap()` failed with no verdict, a click said "clipped by <div#wrap>", and
 * `autoPan` moved the app's camera. The same where the hit test does not find the map for another reason, so that its
 * absence is no sign of a clip: the page set to `pointer-events: none` under the modal (what a modal dialog library does:
 * the page none, the dialog's overlay auto), the map set so, or the map hidden with `visibility: hidden`. There the
 * ancestor counts only if it is on the map's containing-block chain, as CSS clips. A wrapper that is a size container
 * (`container-type: inline-size`, Tailwind's `@container`) is no containing block: read as one, it clipped the map again.
 */
test.describe('a map an overflow ancestor does not contain is covered, not clipped: under a modal, or out of the hit test', () => {
  const layouts = [
    { how: 'absolutely positioned out of a static wrapper with overflow: hidden', wrap: 'overflow:hidden', map: '', container: false },
    { how: 'position: fixed inside a 200 px scrolling panel', wrap: 'position:relative;margin-left:320px;height:200px;overflow:auto', map: 'position:fixed;left:320px;top:0;right:0;bottom:0', container: false },
  ];
  for (const c of [...layouts, ...layouts.map((l) => ({ ...l, how: `${l.how} and container-type: inline-size`, wrap: `${l.wrap};container-type:inline-size`, container: true }))]) {
    for (const h of [
      { how: '', modal: true, body: '', map: '', cover: 'div#modal' },
      { how: ', the page with pointer-events: none and the modal auto', modal: true, body: 'pointer-events:none', map: '', cover: 'div#modal' },
      { how: ', the map with pointer-events: none under the modal', modal: true, body: '', map: 'pointer-events:none', cover: 'div#modal' },
      { how: ', the map hidden with visibility: hidden (no modal)', modal: false, body: '', map: 'visibility:hidden', cover: 'body' },
    ]) {
      // under a plain modal the hit test finds the map: the containing blocks are not read there
      if (c.container && !h.how) continue;
      test(`a map ${c.how}${h.how}: not visible, and a click names ${h.modal ? 'the modal' : 'the page'} and leaves the camera`, async ({ map, page }) => {
        await page.evaluate((c) => {
          const el = document.getElementById('map')!;
          const wrap = document.createElement('div');
          wrap.id = 'wrap';
          wrap.style.cssText = c.wrap;
          if (c.map) el.style.cssText = c.map;
          el.parentElement!.insertBefore(wrap, el);
          wrap.appendChild(el);
          (window as any).__geowright_maps.main.resize();
        }, c);
        await map.waitForIdle();
        const dot = map.feature({ layer: 'alerts', id: 1 });
        await expect(dot, 'control: visible before').toBeVisibleOnMap();
        const outside = await page.evaluate(() => {
          const m = (window as any).__geowright_maps.main;
          const f = m.queryRenderedFeatures({ layers: ['alerts'] }).find((f: any) => f.id === 1);
          const p = m.project(f.geometry.coordinates);
          const c = m.getCanvas().getBoundingClientRect();
          const w = document.getElementById('wrap')!.getBoundingClientRect();
          const y = c.top + p.y;
          return y < w.top || y >= w.bottom;
        });
        expect(outside, "premise: the dot is outside the wrapper's box").toBe(true);
        await page.evaluate((h) => {
          if (h.modal) {
            const modal = document.createElement('div');
            modal.id = 'modal';
            modal.style.cssText = 'position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,0.6);pointer-events:auto';
            document.body.appendChild(modal);
          }
          if (h.body) document.body.style.cssText += ';' + h.body;
          if (h.map) document.getElementById('map')!.style.cssText += ';' + h.map;
          const m = (window as any).__geowright_maps.main;
          (window as any).__moves = 0;
          m.on('movestart', () => (window as any).__moves++);
        }, h);
        await expect(dot).not.toBeVisibleOnMap();
        const message = await dot.click({ autoPan: true, timeout: FAIL_FAST_MS }).then(() => 'passed', (e: Error) => e.message);
        expect(message).toMatch(new RegExp(`dom-covered: every candidate point is covered by DOM element <${h.cover}>`));
        expect(message).not.toMatch(/clipped/);
        expect(await page.evaluate(() => (window as any).__moves), 'autoPan did not move the camera').toBe(0);
      });
    }
  }
});

/**
 * The containing-block chain above (clippedBy) is read from computed styles by holds(); Chromium's layout is the truth. On
 * an ancestor of an absolutely positioned box and of a fixed one, each property that makes a containing block, or looks
 * as if it did: the box at `left: 0; top: 0` lands at the ancestor's padding box if the ancestor holds it, at the page's
 * origin if not. Read wrong, an overflow ancestor clips a map it does not contain (`container-type`, a size container,
 * was read as one), or one that does contain the map is skipped and its clip reads as a cover (`transform-style:
 * preserve-3d`, `offset-path`, `will-change: contain` and, for an absolute box, `will-change: position` were not read).
 * An inline box or a table row holds less than a block (a transform there makes nothing): holds() does not read that.
 */
test("holds() finds Chromium's containing blocks", async ({ page }) => {
  const CASES = [
    '',
    'position:relative',
    'position:sticky',
    'position:absolute',
    'position:fixed',
    'transform:translateX(0px)',
    'translate:1px',
    'rotate:0deg',
    'scale:1',
    'perspective:100px',
    'filter:blur(0px)',
    'backdrop-filter:blur(1px)',
    'offset-path:path("M 0 0 L 10 0");offset-rotate:0deg',
    'offset-position:10px 10px',
    'offset-distance:10px',
    'transform-style:preserve-3d',
    'contain:layout',
    'contain:paint',
    'contain:strict',
    'contain:content',
    'contain:size',
    'contain:style',
    'contain:inline-size',
    'container-type:size',
    'container-type:inline-size',
    'content-visibility:auto',
    'will-change:transform',
    'will-change:translate',
    'will-change:rotate',
    'will-change:scale',
    'will-change:perspective',
    'will-change:filter',
    'will-change:backdrop-filter',
    'will-change:offset',
    'will-change:offset-path',
    'will-change:offset-position',
    'will-change:offset-distance',
    'will-change:transform-style',
    'will-change:transform-origin',
    'will-change:contain',
    'will-change:position',
    'will-change:opacity, position',
    'will-change:background-position',
    'will-change:opacity',
    'clip-path:inset(0)',
    'mask-image:linear-gradient(black,black)',
    'opacity:0.99',
    'isolation:isolate',
    'mix-blend-mode:multiply',
    'zoom:1',
    'display:contents;position:relative',
    'display:contents;transform:translateX(0px)',
  ];
  await page.setContent('<!doctype html><html><body style="margin:0"><div id="host"></div></body></html>');
  const rows = await page.evaluate(
    ({ src, cases }) => {
      const holdsInPage = new Function(`return (${src})`)() as (style: CSSStyleDeclaration, position: string) => boolean;
      const host = document.getElementById('host')!;
      const out: string[] = [];
      for (const css of cases) {
        for (const position of ['absolute', 'fixed']) {
          host.innerHTML = '';
          const a = document.createElement('div'); // the ancestor: away from the origin, with a size of its own
          a.style.cssText = `margin:100px 0 0 200px;width:300px;height:200px;${css}`;
          const mid = document.createElement('div'); // a static box in between, as the canvas container is
          const box = document.createElement('div');
          box.style.cssText = `position:${position};left:0;top:0;width:10px;height:10px`;
          mid.appendChild(box);
          a.appendChild(mid);
          host.appendChild(a);
          const r = box.getBoundingClientRect(), ar = a.getBoundingClientRect();
          const atOrigin = r.left === 0 && r.top === 0, atAncestor = Math.abs(r.left - ar.left) < 1 && Math.abs(r.top - ar.top) < 1;
          const unclear = `unclear (${r.left},${r.top} vs ${ar.left},${ar.top})`;
          // an ancestor with no box (display: contents) holds nothing: the box must be at the origin
          const chromium = a.getClientRects().length === 0 ? (atOrigin ? false : unclear) : atOrigin === atAncestor ? unclear : atAncestor;
          const read = holdsInPage(getComputedStyle(a), position);
          if (read !== chromium) out.push(`${css || '(nothing)'}, ${position} box: Chromium ${chromium}, holds() ${read}`);
        }
      }
      return out;
    },
    { src: holds.toString(), cases: CASES },
  );
  expect(rows).toEqual([]);
});
