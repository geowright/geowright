import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { routeVectorTiles } from '../src/playwright/tiles';

/**
 * Zoomed out far enough that a second copy of the world can be on screen, the pieces of an id-less feature are compared
 * modulo the world's period (the same feature drawn in two copies is one feature). The comparison used to fold each
 * piece on its own, by floor(x0 / period): two touching tile pieces of ONE feature whose left edges fall on either side
 * of a multiple of the period were folded by different amounts, stopped touching, and read as two features.
 *
 * Zoom 1, centre 0, a 960px-wide map: the period is 1024 px and screen x = 0 is lng -168.75. The line crosses the
 * equator, a z1 tile boundary, at lng -164: its south piece starts at lng -178 (x < 0), its north piece east of x = 0.
 */
const LINE = { type: 'LineString' as const, coordinates: [[-178, -10], [-150, 10]] };

async function tiledLine(page: Page, view: { center: [number, number]; zoom: number }) {
  await routeVectorTiles(page, '**/vt/fold/**', { lines: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { kind: 'route' }, geometry: LINE }] } });
  await page.evaluate((view) => {
    const m = (window as any).__geowright_maps.main;
    m.addSource('fold', { type: 'vector', tiles: [`${location.origin}/vt/fold/{z}/{x}/{y}.pbf`], maxzoom: 14 });
    m.addLayer({ id: 'fold', type: 'line', source: 'fold', 'source-layer': 'lines', paint: { 'line-width': 6, 'line-color': '#c0f' } });
    (window as any).__foldClicks = 0;
    m.on('click', 'fold', () => (window as any).__foldClicks++);
    m.jumpTo(view);
  }, view);
}

test.describe('world copies (a zoomed-out map)', () => {
  test('one id-less tiled line whose pieces straddle a period boundary is ONE feature, and click() acts on it', async ({ map, page }) => {
    await tiledLine(page, { center: [0, 0], zoom: 1 });
    await map.waitForIdle();
    // it really is in pieces here (else this would test nothing)
    expect(await page.evaluate(() => (window as any).__geowright_maps.main.queryRenderedFeatures({ layers: ['fold'] }).length)).toBeGreaterThan(1);
    await expect(map.features({ layer: 'fold' })).toHaveFeatureCount(1);
    await map.feature({ layer: 'fold' }).click();
    expect(await page.evaluate(() => (window as any).__foldClicks)).toBe(1);
  });

  test('the same line zoomed in (no second copy on screen) is one feature', async ({ map, page }) => {
    await tiledLine(page, { center: [-164, 0], zoom: 3 });
    await map.waitForIdle();
    await expect(map.features({ layer: 'fold' })).toHaveFeatureCount(1);
  });
});
