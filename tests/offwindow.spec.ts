import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { FAIL_FAST_MS } from './slow-machine';

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
