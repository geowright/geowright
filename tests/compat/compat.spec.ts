import { test as base, expect as baseExpect } from '@playwright/test';
import { geowright, expect, type MapHandle } from '../../src/playwright';
import { routeVectorTiles } from '../../src/playwright/tiles';
import { LIBS } from './libs';

/**
 * The version matrix: the SAME page and the SAME specs against every MapLibre / Mapbox-GL-v1-API major.
 * What is asserted here is the README's support table. A capability an old version lacks is not skipped
 * silently: the spec asserts WHAT the library says about it (caveats, error text).
 */
const PARCELS = {
  type: 'FeatureCollection' as const,
  features: [0, 1, 2].map((i) => ({
    type: 'Feature' as const,
    id: 500 + i,
    properties: { parcel: `P${i}`, owner: i === 1 ? 'city' : 'private' },
    geometry: { type: 'Polygon' as const, coordinates: [[[34.74 + i * 0.03, 32.125], [34.76 + i * 0.03, 32.125], [34.76 + i * 0.03, 32.135], [34.74 + i * 0.03, 32.135], [34.74 + i * 0.03, 32.125]]] },
  })),
};

for (const lib of LIBS) {
  const test = base.extend<{ map: MapHandle }>({
    map: async ({ page, baseURL }, use) => {
      const external: string[] = [];
      await page.route(/^https?:\/\//, (route) => {
        const url = route.request().url();
        if (url.startsWith(baseURL!)) return route.fallback();
        external.push(url);
        return route.abort();
      });
      await routeVectorTiles(page, '**/vt/parcels/**', { parcels: PARCELS });
      await page.goto(`/?lib=${lib.alias}`);
      const map = geowright(page);
      await map.waitForIdle();
      await use(map);
      if (external.length) throw new Error(`external network requests are not allowed in tests:\n${external.join('\n')}`);
    },
  });

  test.describe(lib.label, () => {
    test('assert: features appear, change and disappear', async ({ map, page }) => {
      await expect(map.features({ layer: 'places' })).toHaveFeatureCount(5);
      await expect(map.features({ layer: 'places', where: { kind: 'cafe' } })).toHaveFeatureCount(2);
      await expect(map).not.toHaveFeature({ layer: 'places', where: { name: 'Foxtrot' } });
      await page.locator('#add').click();
      await expect(map).toHaveFeature({ layer: 'places', id: 6, where: { name: 'Foxtrot' } });
      await page.locator('#remove').click();
      await expect(map).not.toHaveFeature({ layer: 'places', where: { name: 'Foxtrot' } });
      await page.locator('#toggle-zones').click();
      await expect(map).not.toHaveFeature({ layer: 'zones' });
    });

    test('act: click and hover a point, click a polygon, click a line', async ({ map, page }) => {
      await map.feature({ layer: 'places', where: { name: 'Bravo' } }).click();
      await baseExpect(page.getByTestId('clicked')).toHaveText('places:Bravo');
      await map.feature({ layer: 'places', id: 3 }).hover();
      await baseExpect(page.getByTestId('hovered')).toHaveText('Charlie');
      await map.feature({ layer: 'zones', where: { zone: 'south' } }).click();
      await baseExpect(page.getByTestId('clicked')).toHaveText('zones:south');
      await map.feature({ layer: 'roads', id: 30 }).click(); // no handler: must simply not throw
    });

    test('occlusion: a point under a polygon is refused, and says what covers it', async ({ map, page }) => {
      const echo = map.feature({ layer: 'places', where: { name: 'Echo' } });
      const err = await echo.click({ timeout: 1500 }).then(() => null, (e: Error) => e);
      expect(err?.message).toContain('occluded');
      expect(err?.message).toContain('cover');
      await echo.click({ force: true });
      await baseExpect(page.getByTestId('clicked')).toHaveText('places:Echo');
    });

    test('visibility: an opacity-0 feature is rendered but not visible', async ({ map }) => {
      await expect(map).not.toHaveFeature({ layer: 'ghosts' });
      await expect(map).toHaveFeature({ layer: 'ghosts' }, { visible: 'any' });
      await expect(map.feature({ layer: 'ghosts', visible: 'any' })).not.toBeVisibleOnMap();
      await expect(map.feature({ layer: 'places', id: 1 })).toBeVisibleOnMap();
      const err = await map.feature({ layer: 'ghosts' }).click({ timeout: 1000 }).then(() => null, (e: Error) => e);
      expect(err?.message).toContain('circle-opacity');
    });

    test('pixel probe: ground truth on every version; a version without redraw() says how it was done', async ({ map, page }) => {
      await expect(map.feature({ layer: 'places', id: 1 })).toBeVisibleOnMap({ pixels: true });
      await expect(map).toHaveLayerPixels('cover', { at: { lng: 34.86, lat: 32.11 } });
      await expect(map).not.toHaveLayerPixels('cover', { at: { lng: 34.8, lat: 32.0 } });
      const sync = await page.evaluate(() => typeof (window as any).__geowright_maps.main.redraw === 'function');
      const note = 'no synchronous redraw()';
      if (sync) expect(await map.snapshot()).not.toContain(note);
      else expect(await map.snapshot()).toContain(note);
    });

    test('snapshot: layers, entities, colours, clickable pixels', async ({ map }) => {
      const text = await map.snapshot();
      expect(text).toContain('[places] 5 circle entities');
      expect(text).toMatch(/circle-color is data-driven: .*blue\(#1976d2\)×3.*red\(#d32f2f\)×2/);
      expect(text).toMatch(/#2 Point @\(\d+,\d+\).* name="Bravo"/);
      expect(text).toMatch(/#5 Point @\(\d+,\d+\) covered-by:cover#20/);
      expect(text).toContain('also drawn by: place-labels');
      expect(text).toContain('[parcels] 3 fill entities');
    });

    test('markers and popups', async ({ map, page }) => {
      const marker = await map.marker({ at: { lng: 34.72, lat: 32.11 } });
      await marker.click();
      await expect(map).toHavePopup({ at: { lng: 34.72, lat: 32.11 }, text: 'Marker popup', tolerancePx: 40 });
      await baseExpect(await map.popup()).toHaveText('Marker popup');
      await page.keyboard.press('Escape');
    });

    test('source data: off-screen features are known, named in failures, and reachable with autoPan', async ({ map, page }) => {
      // GeoJSONSource.getData() is MapLibre >= 4; below that the adapter reads the data back through serialize().
      const golf = map.feature({ layer: 'places', where: { name: 'Golf' } });
      const err = await golf.click({ timeout: 1000 }).then(() => null, (e: Error) => e);
      expect(err?.message).toContain('exist in the source but are not rendered');
      expect(await map.snapshot()).toMatch(/1 feature\(s\) OUTSIDE the viewport .*#7 to the north-east/);
      await golf.click({ autoPan: true });
      await baseExpect(page.getByTestId('clicked')).toHaveText('places:Golf');
    });

    test('vector tiles: assert and act on features that come from tiles', async ({ map, page }) => {
      await expect(map.features({ layer: 'parcels' })).toHaveFeatureCount(3);
      await map.feature({ layer: 'parcels', where: { owner: 'city' } }).click();
      await baseExpect(page.getByTestId('clicked')).toHaveText('parcels:P1');
    });

    test('camera and locations: toHaveView, clickAt, drag pans, geometry from the source', async ({ map, page }) => {
      await expect(map).toHaveView({ zoom: 11, center: { lng: 34.8, lat: 32.08 } });
      await map.clickAt({ lng: 34.72, lat: 32.035 });
      await baseExpect(page.getByTestId('clicked')).toHaveText('zones:north');
      await map.dragAt({ lng: 34.8, lat: 32.0 }, { lng: 34.78, lat: 32.0 });
      const view = await map.viewState();
      expect(view.center.lng).toBeGreaterThan(34.81);
      await expect(map.feature({ layer: 'zones', id: 10 })).toHaveGeometry({ type: 'Polygon', coordinates: [[[34.7, 32.02], [34.74, 32.02], [34.74, 32.05], [34.7, 32.05], [34.7, 32.02]]] });
    });
  });
}
