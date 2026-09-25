import { test as base, expect as baseExpect } from '@playwright/test';
import { geowright, expect, type MapHandle } from '../../src/playwright';
import { routeVectorTiles } from '../../src/playwright/tiles';
import { guardNetwork } from '../fixtures';
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
      const guard = await guardNetwork(page, baseURL!); // the exact origin, as in the core suite: :41750 is not :4175
      await routeVectorTiles(page, '**/vt/parcels/**', { parcels: PARCELS });
      await page.goto(`/?lib=${lib.alias}`);
      const map = geowright(page);
      await map.waitForIdle();
      await use(map);
      guard.check();
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

    // the probe compares the pixels with and without the layer. Pixels that change by themselves (an animation
    // under the feature; on Mapbox GL v1 the reads are two REAL frames apart) are no evidence: a control read decides.
    test('pixel probe: pixels that change by themselves are no evidence (control read)', async ({ map, page }) => {
      await page.evaluate(() => {
        const m = (window as any).__geowright_maps.main;
        m.addSource('b6', { type: 'geojson', data: { type: 'FeatureCollection', features: [{ type: 'Feature', id: 60, properties: {}, geometry: { type: 'Point', coordinates: [34.77, 32.03] } }] } });
        // no paint transition: the pixels change only when the app changes them (MapLibre 2–4 advance a transition only
        // on a style change, which the probe's own hide is — a residual, docs/DESIGN.md)
        m.addLayer({ id: 'b6-under', type: 'circle', source: 'b6', paint: { 'circle-radius': 24, 'circle-color': '#000', 'circle-color-transition': { duration: 0 } } });
        // paints (alpha > 0) but changes no pixel a user could see
        m.addLayer({ id: 'b6', type: 'circle', source: 'b6', paint: { 'circle-radius': 12, 'circle-color': 'rgba(255, 0, 0, 0.0001)' } });
        let i = 0;
        const tick = () => {
          m.setPaintProperty('b6-under', 'circle-color', i++ % 2 ? '#000' : '#fff');
          requestAnimationFrame(tick);
        };
        tick();
      });
      const e = await expect(map.feature({ layer: 'b6', id: 60 })).toBeVisibleOnMap({ timeout: 3000 }).then(() => null, (e: Error) => e);
      expect(e, 'toBeVisibleOnMap passed for a feature that changes no pixel, because the pixels under it change by themselves').not.toBeNull();
    });

    // style evaluation on every version — zoom- and feature-state-driven paint, a legacy { stops } function, promoteId.
    test('style evaluation: zoom and feature-state paint, legacy stops, promoteId', async ({ map, page }) => {
      await page.evaluate(() => {
        const m = (window as any).__geowright_maps.main;
        const pt = (code: number, lng: number, lat: number) => ({ type: 'Feature', properties: { code }, geometry: { type: 'Point', coordinates: [lng, lat] } });
        m.addSource('b16', { type: 'geojson', promoteId: 'code', data: { type: 'FeatureCollection', features: [pt(71, 34.81, 32.07), pt(72, 34.79, 32.07)] } });
        m.addLayer({ id: 'b16-state', type: 'circle', source: 'b16', paint: { 'circle-radius': 8, 'circle-opacity': ['case', ['boolean', ['feature-state', 'gone'], false], 0, 1] } });
        m.addLayer({ id: 'b16-zoom', type: 'circle', source: 'b16', paint: { 'circle-radius': 5, 'circle-opacity': ['step', ['zoom'], 0, 12, 1] } });
        m.addLayer({ id: 'b16-stops', type: 'circle', source: 'b16', paint: { 'circle-radius': { stops: [[10, 0], [11.5, 0], [12, 4]] } } });
      });
      await expect(map).toHaveFeature({ layer: 'b16-state', id: 71 }); // promoteId: the id is the "code" property
      await page.evaluate(() => (window as any).__geowright_maps.main.setFeatureState({ source: 'b16', id: 71 }, { gone: true }));
      await expect(map).not.toHaveFeature({ layer: 'b16-state', id: 71 });
      await expect(map).toHaveFeature({ layer: 'b16-state', id: 71 }, { visible: 'any' });
      await expect(map).toHaveFeature({ layer: 'b16-state', id: 72 });
      await expect(map).not.toHaveFeature({ layer: 'b16-zoom' });
      await expect(map).not.toHaveFeature({ layer: 'b16-stops' });
      await page.evaluate(() => (window as any).__geowright_maps.main.jumpTo({ zoom: 12.5 }));
      await expect(map.features({ layer: 'b16-zoom' })).toHaveFeatureCount(2);
      await expect(map.features({ layer: 'b16-stops' })).toHaveFeatureCount(2);
    });

    test('idle diagnosis: an app that re-sets a source in a loop is told so when it is not idle', async ({ map, page }) => {
      await page.evaluate(() => {
        const m = (window as any).__geowright_maps.main;
        const data = (t: number) => ({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [34.8 + 0.01 * Math.sin(t / 300), 32.05] } }] });
        m.addSource('loop', { type: 'geojson', data: data(0) });
        m.addLayer({ id: 'loop', type: 'circle', source: 'loop', paint: { 'circle-radius': 6 } });
        const tick = (t: number) => {
          m.getSource('loop').setData(data(t));
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      // Measured on this matrix: every version can fire 'idle' between two setData calls of such a loop now and then
      // (Mapbox GL 1.13 and MapLibre 2–5 were each seen idle within 2.5 s in some runs; 6 was not). So: if the map was not idle, the reason
      // given must be the loop — never "loading" or "slow".
      const e = await map.waitForIdle({ timeout: 2500 }).then(() => null, (e: Error) => e);
      if (e) expect(e.message).toMatch(/the app keeps replacing the data of source\(s\) loop \(\d+ times in \d+ms\)/);
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

    test('source data given as a URL: off-screen features known where getData() exists, "unknowable" said where not', async ({ map, page }) => {
      const at = (name: string, lng: number, lat: number) => ({ type: 'Feature', id: name.length, properties: { name }, geometry: { type: 'Point', coordinates: [lng, lat] } });
      await page.route('**/url-places.geojson', (route) =>
        route.fulfill({ contentType: 'application/json', body: JSON.stringify({ type: 'FeatureCollection', features: [at('Hotel', 34.82, 32.07), at('India', 35.6, 32.45)] }) }));
      const getData = await page.evaluate(() => {
        const m = (window as any).__geowright_maps.main;
        m.addSource('url-places', { type: 'geojson', data: `${location.origin}/url-places.geojson` });
        m.addLayer({ id: 'url-places', type: 'circle', source: 'url-places', paint: { 'circle-radius': 7, 'circle-color': '#6a1b9a' } });
        return typeof m.getSource('url-places').getData === 'function';
      });
      expect(getData, 'GeoJSONSource.getData() is MapLibre >= 4').toBe(!/^(mapbox-gl-1|maplibre-gl-[23])$/.test(lib.alias));
      await expect(map).toHaveFeature({ layer: 'url-places', where: { name: 'Hotel' } });
      await map.waitForIdle();
      const india = map.feature({ layer: 'url-places', where: { name: 'India' } });
      const err = await india.click({ timeout: 1000 }).then(() => null, (e: Error) => e);
      const snap = await map.snapshot();
      const note = 'source(s) url-places: this map library version has no GeoJSONSource.getData() and the source was given a URL — features outside the viewport and full geometries are unknowable';
      if (getData) {
        expect(err?.message).toContain('exist in the source but are not rendered');
        expect(snap).not.toContain(note);
        expect(snap).toMatch(/\[source url-places\] 1 feature\(s\) OUTSIDE the viewport .*#5 to the north-east/);
        await india.click({ autoPan: true });
      } else {
        expect(err?.message).not.toContain('exist in the source but are not rendered');
        expect(err?.message).toContain(note);
        expect(snap).toContain(note);
      }
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
