import type { Page } from '@playwright/test';
import type { FeatureCollection } from 'geojson';
import { test, expect } from './fixtures';
import { vectorTileHandler } from '../src/playwright/tiles';
import type { MapHandle } from '../src/playwright';
import { FAIL_FAST_MS } from './slow-machine';

/**
 * Identity against what MapLibre does to GeoJSON on its way to the screen (docs/DESIGN.md § Identity):
 *  - a feature id that is not a non-negative integer is coerced (vt-pbf: parseInt, then a varint: 'north-gate' → 0,
 *    -5 → 18446744073709552000, 1.5 → 1), so the rendered id is not the app's;
 *  - a property whose value is null is dropped from the rendered feature, while the source data keeps it.
 * Queries are by the app's ids and the app's data; the renderer's rewrite must not make them match nothing (a negative
 * assertion by id then passes on a feature that is drawn) or merge look-alikes into one.
 */

const ring = (w: number, s: number, e: number, n: number) => [[[w, s], [e, s], [e, n], [w, n], [w, s]]];

/** Adds a GeoJSON circle layer `gates` on top of the demo map, one point per [id, dx] (degrees east of the centre). */
async function addGates(page: Page, gates: [id: string | number, dx: number, props?: Record<string, unknown>][]) {
  await page.evaluate((gates) => {
    const m = (window as any).__geowright_maps.main;
    const c = m.getCenter();
    const features = gates.map(([id, dx, props]) => ({ type: 'Feature', id, properties: props ?? { kind: 'gate' }, geometry: { type: 'Point', coordinates: [c.lng + dx, c.lat] } }));
    m.addSource('gates', { type: 'geojson', data: { type: 'FeatureCollection', features } });
    m.addLayer({ id: 'gates', type: 'circle', source: 'gates', paint: { 'circle-radius': 8, 'circle-color': '#0a0' } });
  }, gates);
}

test.describe('GeoJSON ids the renderer coerces', () => {
  test('look-alikes whose string ids coerce to one number are counted apart', async ({ map, page }) => {
    await addGates(page, [['north-gate', -0.01], ['south-gate', 0.01]]);
    await expect(map.features({ layer: 'gates' })).toHaveFeatureCount(2);
  });

  test('a drawn feature is found by its string id, so a negative assertion by that id fails', async ({ map, page }) => {
    await addGates(page, [['north-gate', 0]]);
    await expect(map.features({ layer: 'gates' })).toHaveFeatureCount(1);
    await expect(map).toHaveFeature({ layer: 'gates', id: 'north-gate' });
    const e = await expect(map).not.toHaveFeature({ layer: 'gates', id: 'north-gate' }, { timeout: FAIL_FAST_MS }).then(() => null, (e: Error) => e);
    expect(e, '.not.toHaveFeature by the id of a feature that is drawn').not.toBeNull();
    await expect(map).not.toHaveFeature({ layer: 'gates', id: 'south-gate' }); // not in the data: truly absent
  });

  test('a query by string id picks that one of two look-alikes, and clicks it', async ({ map, page }) => {
    await addGates(page, [['north-gate', -0.01], ['south-gate', 0.01]]);
    await page.evaluate(() => {
      const m = (window as any).__geowright_maps.main;
      (window as any).__gateClicks = [];
      m.on('click', 'gates', (e: any) => (window as any).__gateClicks.push(e.lngLat.lng - m.getCenter().lng));
    });
    await expect(map.features({ layer: 'gates', id: 'north-gate' })).toHaveFeatureCount(1);
    await expect(map.features({ layer: 'gates', id: 'south-gate' })).toHaveFeatureCount(1);
    await map.feature({ layer: 'gates', id: 'south-gate' }).click();
    const clicks: number[] = await page.evaluate(() => (window as any).__gateClicks);
    expect(clicks).toHaveLength(1);
    expect(clicks[0], 'the click landed on south-gate (east of the centre), not its look-alike').toBeGreaterThan(0.005);
  });

  test('negative and fractional ids are found by the id the app gave them', async ({ map, page }) => {
    await addGates(page, [[-5, -0.01, { kind: 'minus' }], [1.5, 0.01, { kind: 'half' }]]);
    await expect(map).toHaveFeature({ layer: 'gates', id: -5, where: { kind: 'minus' } });
    await expect(map).toHaveFeature({ layer: 'gates', id: 1.5, where: { kind: 'half' } });
  });

  /** A gate under the demo's red marker (34.805, 32.1), and its look-alike elsewhere. */
  async function gatesUnderMarker(page: Page) {
    await page.getByTestId('toggle-markers').check();
    await page.evaluate(() => {
      const m = (window as any).__geowright_maps.main;
      const gate = (id: string, lng: number, lat: number) => ({ type: 'Feature', id, properties: { kind: 'gate' }, geometry: { type: 'Point', coordinates: [lng, lat] } });
      m.addSource('gates', { type: 'geojson', data: { type: 'FeatureCollection', features: [gate('north-gate', 34.805, 32.1), gate('south-gate', 34.76, 32.07)] } });
      m.addLayer({ id: 'gates', type: 'circle', source: 'gates', paint: { 'circle-radius': 8, 'circle-color': '#0a0' } });
    });
  }

  test('a snapshot filter by string id lists that feature, not its look-alike', async ({ map, page }) => {
    await gatesUnderMarker(page);
    await map.waitForIdle();
    expect(await map.snapshot({ filter: { layer: 'gates', id: 'north-gate' } })).toMatch(/\[gates\] 1 circle entity/);
  });

  test('a marker on a feature given by string id is found', async ({ map, page }) => {
    await gatesUnderMarker(page);
    await expect(map).toHaveFeature({ layer: 'gates' });
    await expect(await map.marker({ feature: { layer: 'gates', id: 'north-gate' } })).toHaveAttribute('class', /maplibregl-marker/);
  });

  test('a string id on a tiled source without promoteId is an error that names promoteId, not "no match"', async ({ map }) => {
    await expect(map.features({ layer: 'buildings' })).toHaveFeatureCount(25);
    for (const not of [false, true]) {
      const m = not ? expect(map).not : expect(map);
      const e = await m.toHaveFeature({ layer: 'buildings', id: 'b-1013' }, { timeout: FAIL_FAST_MS }).then(() => null, (e: Error) => e);
      expect(e, `${not ? '.not.' : ''}toHaveFeature by a string id on a vector source`).not.toBeNull();
      expect(e?.message).toContain('promoteId');
    }
  });
});

test.describe('null-valued GeoJSON properties (dropped from rendered features)', () => {
  async function addPond(page: Page, map: MapHandle, properties: Record<string, unknown>, jump = false) {
    await page.evaluate(
      ({ coordinates, properties, jump }) => {
        const m = (window as any).__geowright_maps.main;
        m.addSource('ponds', { type: 'geojson', data: { type: 'FeatureCollection', features: [{ type: 'Feature', properties, geometry: { type: 'Polygon', coordinates } }] } });
        m.addLayer({ id: 'ponds', type: 'fill', source: 'ponds', paint: { 'fill-color': '#06f', 'fill-opacity': 0.4 } });
        // z12 tile border at lng 34.8046875: the pond is cut into two rendered pieces
        if (jump) m.jumpTo({ center: [34.805, 32.08], zoom: 12.5 });
      },
      { coordinates: ring(34.79, 32.07, 34.82, 32.09), properties, jump },
    );
    await map.waitForIdle();
  }

  test('the snapshot does not report a drawn feature with a null property as undrawn', async ({ map, page }) => {
    await addPond(page, map, { name: 'Pond', note: null }, true);
    await expect(map.features({ layer: 'ponds' })).toHaveFeatureCount(1);
    const snap = await map.snapshot({ layers: ['ponds'] });
    expect(snap).toMatch(/\[ponds\] 1 fill entity/);
    expect(snap).not.toContain('not drawn individually');
  });

  test('geometry() of a feature with a null property is the source geometry, not the rendered pieces', async ({ map, page }) => {
    await addPond(page, map, { name: 'Pond', note: null });
    expect(await map.feature({ layer: 'ponds' }).geometry()).toEqual({ type: 'Polygon', coordinates: ring(34.79, 32.07, 34.82, 32.09) });
  });
});

test.describe('vector tiles: ids are unique per source-layer only', () => {
  test('a same-id, same-properties feature of another source-layer drawn on top is an occluder, not the target', async ({ map, page }) => {
    const lot = (): FeatureCollection => ({ type: 'FeatureCollection', features: [{ type: 'Feature', id: 7, properties: { kind: 'lot' }, geometry: { type: 'Polygon', coordinates: ring(34.775, 32.075, 34.785, 32.085) } }] });
    await page.route('**/vt/twin/**', vectorTileHandler({ under: lot(), over: lot() }));
    await page.evaluate(() => {
      const m = (window as any).__geowright_maps.main;
      m.addSource('twin', { type: 'vector', maxzoom: 14, tiles: [location.origin + '/vt/twin/{z}/{x}/{y}.pbf'] });
      m.addLayer({ id: 'twin-under', type: 'fill', source: 'twin', 'source-layer': 'under', paint: { 'fill-color': '#c00' } });
      m.addLayer({ id: 'twin-over', type: 'fill', source: 'twin', 'source-layer': 'over', paint: { 'fill-color': '#00c' } });
    });
    await expect(map.features({ layer: 'twin-under' })).toHaveFeatureCount(1);
    await expect(map.features({ layer: 'twin-over' })).toHaveFeatureCount(1);
    const e = await map.feature({ layer: 'twin-under' }).click({ timeout: FAIL_FAST_MS }).then(() => null, (e: Error) => e);
    expect(e, 'a click on a feature entirely under another layer').not.toBeNull();
    expect(e?.message).toContain('covered by another feature; topmost is twin-over#7');
  });
});

/** `generateId: true`: MapLibre replaces every GeoJSON id with the feature's index. A query by the data's id is by the data. */
test.describe('a GeoJSON source with generateId', () => {
  const add = (page: Page) =>
    page.evaluate(() => {
      const m = (window as any).__geowright_maps.main;
      m.addSource('gen', {
        type: 'geojson',
        generateId: true,
        data: { type: 'FeatureCollection', features: [
          { type: 'Feature', id: 1, properties: { name: 'first, data id 1' }, geometry: { type: 'Point', coordinates: [34.79, 32.07] } },
          { type: 'Feature', id: 0, properties: { name: 'second, data id 0' }, geometry: { type: 'Point', coordinates: [34.81, 32.07] } },
        ] },
      });
      m.addLayer({ id: 'gen', type: 'circle', source: 'gen', paint: { 'circle-radius': 10, 'circle-color': '#0a0' } });
      const w = window as any;
      w.__genClicks = [];
      m.on('click', 'gen', (e: any) => w.__genClicks.push(e.features[0].properties.name));
    });

  test("feature({ id }) is the feature with that id in the app's data, not the one at that index", async ({ map, page }) => {
    await add(page);
    await map.waitForIdle();
    expect((await map.feature({ layer: 'gen', id: 1 }).info()).properties.name).toBe('first, data id 1');
    await map.feature({ layer: 'gen', id: 1 }).click();
    expect(await page.evaluate(() => (window as any).__genClicks)).toEqual(['first, data id 1']);
  });

  test('the snapshot does not call the drawn features "not drawn individually"', async ({ map, page }) => {
    await add(page);
    await map.waitForIdle();
    expect(await map.snapshot()).not.toMatch(/\[source gen\] \d+ feature\(s\) are inside the view but not drawn individually/);
  });
});
