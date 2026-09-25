import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { FAIL_FAST_MS } from './slow-machine';

/**
 * Locations and geometry just across the antimeridian. Seen from lng 179.5, lng -179.8 is drawn 0.7° EAST of the centre
 * (the world copy nearest the view), not 359° west: what a user sees there is what a location, a query `at` and a
 * geometry comparison must mean.
 */

/** A dot at lng -179.8 (east of 180), a short line across the meridian's east side, and the camera just west of 180. */
async function across(page: Page, o: { renderWorldCopies?: boolean } = {}) {
  await page.evaluate((o) => {
    const w = window as any;
    const m = w.__geowright_maps.main;
    if (o.renderWorldCopies === false) m.setRenderWorldCopies(false);
    m.addSource('am', { type: 'geojson', data: { type: 'Feature', id: 1, properties: { name: 'east of 180' }, geometry: { type: 'Point', coordinates: [-179.8, 0] } } });
    m.addLayer({ id: 'am', type: 'circle', source: 'am', paint: { 'circle-radius': 10, 'circle-color': '#f60' } });
    m.addSource('am-line', { type: 'geojson', data: { type: 'Feature', id: 2, properties: { name: 'line east of 180' }, geometry: { type: 'LineString', coordinates: [[-179.9, 0.3], [-179.6, 0.4]] } } });
    m.addLayer({ id: 'am-line', type: 'line', source: 'am-line', paint: { 'line-width': 4, 'line-color': '#06f' } });
    // a 24-gon of radius 0.1° around (-179.8, -0.3): near the equator Mercator draws it as a circle
    const ring = Array.from({ length: 25 }, (_, i) => [-179.8 + 0.1 * Math.cos((i * 2 * Math.PI) / 24), -0.3 + 0.1 * Math.sin((i * 2 * Math.PI) / 24)]);
    m.addSource('am-circle', { type: 'geojson', data: { type: 'Feature', id: 3, properties: { name: 'circle east of 180' }, geometry: { type: 'Polygon', coordinates: [ring] } } });
    m.addLayer({ id: 'am-circle', type: 'fill', source: 'am-circle', paint: { 'fill-color': '#0a0' } });
    w.__amClicks = 0;
    w.__amAt = null;
    m.on('click', 'am', () => w.__amClicks++);
    m.on('click', (e: any) => (w.__amAt = e.lngLat.wrap().toArray()));
    m.jumpTo({ center: [179.5, 0], zoom: 6 });
  }, o);
}

test.describe('antimeridian', () => {
  test('clickAt a location just across the antimeridian clicks where it is drawn', async ({ map, page }) => {
    await across(page);
    await map.waitForIdle();
    const e = await map.clickAt({ lng: -179.8, lat: 0 }).then(() => null, (e: Error) => e);
    const got = await page.evaluate(() => ({ clicks: (window as any).__amClicks, at: (window as any).__amAt as number[] | null }));
    expect({ error: e?.message.split('\n')[0] ?? null, clicks: got.clicks }).toEqual({ error: null, clicks: 1 });
    // where the app's own click event says the real input landed: within a few pixels (1px is about 0.011° at zoom 6) of the location
    expect(Math.abs(got.at![0] - -179.8)).toBeLessThan(0.05);
    expect(Math.abs(got.at![1])).toBeLessThan(0.05);
  });

  test('a query at a location just across the antimeridian finds, and clicks, what is drawn there', async ({ map, page }) => {
    await across(page);
    await map.waitForIdle();
    await expect(map).toHaveFeature({ layer: 'am', at: { lng: -179.8, lat: 0 } });
    await map.feature({ layer: 'am', at: { lng: -179.8, lat: 0 } }).click();
    expect(await page.evaluate(() => (window as any).__amClicks)).toBe(1);
  });

  test('on a pitched map, a location just across the antimeridian is on the visible surface', async ({ map, page }) => {
    // the far copy, 359° west, is beyond the horizon: whether a location is hidden is decided in the copy in view too
    await across(page);
    await page.evaluate(() => (window as any).__geowright_maps.main.jumpTo({ pitch: 60 }));
    await map.waitForIdle();
    await expect(map).toHaveFeature({ layer: 'am', at: { lng: -179.8, lat: 0 } });
    await map.clickAt({ lng: -179.8, lat: 0 });
    expect(await page.evaluate(() => (window as any).__amClicks)).toBe(1);
  });

  test('layer pixels at a location just across the antimeridian are the ones drawn in view', async ({ map, page }) => {
    await across(page);
    await map.waitForIdle();
    await expect(map).toHaveLayerPixels('am', { at: { lng: -179.8, lat: 0 }, radiusPx: 6 });
  });

  test('toHaveGeometry across the antimeridian compares what is drawn, with a tight tolerance', async ({ map, page }) => {
    await across(page);
    await map.waitForIdle();
    // the same places written in the copy the user sees (lng > 180) and in the canonical one: both are what is drawn
    await expect(map.feature({ layer: 'am' })).toHaveGeometry({ type: 'Point', coordinates: [180.2, 0] }, { tolerancePx: 1 });
    await expect(map.feature({ layer: 'am' })).toHaveGeometry({ type: 'Point', coordinates: [-179.8, 0] }, { tolerancePx: 1 });
    await expect(map.feature({ layer: 'am-line' })).toHaveGeometry({ type: 'LineString', coordinates: [[180.1, 0.3], [180.4, 0.4]] }, { tolerancePx: 1 });
    await expect(map.feature({ layer: 'am-circle' })).toHaveGeometry({ circle: { center: { lng: 180.2, lat: -0.3 }, edge: { lng: 180.3, lat: -0.3 } } }, { tolerancePx: 1 });
    // and a real difference is still one: 0.1° is about 9 px at zoom 6
    await expect(map.feature({ layer: 'am' })).not.toHaveGeometry({ type: 'Point', coordinates: [180.3, 0] }, { tolerancePx: 1 });
  });

  test('without world copies there is no nearer copy: a location across the antimeridian is outside the view', async ({ map, page }) => {
    await across(page, { renderWorldCopies: false });
    await map.waitForIdle();
    const err = await map.clickAt({ lng: -179.8, lat: 0 }, { timeout: FAIL_FAST_MS }).then(() => null, (e: Error) => e);
    expect(err?.message).toContain('outside the viewport');
    expect(await page.evaluate(() => (window as any).__amClicks)).toBe(0);
  });
});
