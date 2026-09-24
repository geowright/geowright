import { test, expect } from './fixtures';
import { BUILDINGS } from './buildings';
import { vectorTileHandler } from '../src/playwright/tiles';

/**
 * Vector-tile sources: the browser only ever holds the tiles in view, so the library cannot know
 * what exists off-screen. Everything in view works exactly like GeoJSON.
 */
test.describe('vector tile layer', () => {
  test('assert and act on features that come from tiles', async ({ map, page }) => {
    await expect(map.features({ layer: 'buildings' })).toHaveFeatureCount(25);
    await expect(map.features({ layer: 'buildings', where: { kind: 'office' } })).toHaveFeatureCount(8);
    await expect(map).toHaveFeature({ layer: 'buildings', id: 1013, where: { floors: { gte: 1 } } });

    await map.feature({ layer: 'buildings', id: 1013 }).click();
    const popup = page.getByTestId('popup');
    await expect(popup).toHaveAttribute('data-kind', 'building');
    await expect(popup).toHaveAttribute('data-id', '1013');
  });

  test('layer toggle', async ({ map, page }) => {
    await page.getByTestId('toggle-buildings').uncheck();
    await expect(map).not.toHaveFeature({ layer: 'buildings' });
    await page.getByTestId('toggle-buildings').check();
    await expect(map.features({ layer: 'buildings' })).toHaveFeatureCount(25);
  });

  test('off-screen: honest about what cannot be known; autoPan takes a location', async ({ map, page }) => {
    const far = map.feature({ layer: 'buildings', id: 1028 });
    const err = await far.click({ timeout: 700 }).then(() => null, (e: Error) => e);
    expect(err?.message).toContain('uses a tiled (vector) source');
    expect(err?.message).toContain('{ autoPan: { lng, lat } }');

    // `autoPan: true` has nothing to look up for tiles: same clear failure, not a hang or a wrong click
    const err2 = await far.click({ timeout: 700, autoPan: true }).then(() => null, (e: Error) => e);
    expect(err2?.message).toContain('uses a tiled (vector) source');

    await far.click({ autoPan: { lng: 35.2, lat: 32.092 } });
    await expect(page.getByTestId('popup')).toHaveAttribute('data-id', '1028');
  });

  test('tiles load while we wait: fly to an area whose tiles were never fetched', async ({ map, page }) => {
    await page.getByTestId('fly-east').click();
    // no waitForIdle on purpose: the assertion must ride out the animation AND the tile fetches
    await expect(map.features({ layer: 'buildings' })).toHaveFeatureCount(6);
    await expect(map).toHaveView({ center: { lng: 35.2, lat: 32.08 } });
  });

  test('snapshot says which layers are tiled and therefore blind off-screen', async ({ map }) => {
    const snap = await map.snapshot({ perLayer: 3 });
    expect(snap).toContain('buildings(fill,vector)');
    expect(snap).toMatch(/\[buildings\] 25 fill entities/);
    expect(snap).toMatch(/… 22 more not listed \(nearest to the view centre are listed\)\. Summary of all \d+ — .*kind: house×\d+, office×\d+/);
    expect(snap).toContain('note: tiled source(s) buildings (1 layer): features outside the viewport are unknowable from here.');
  });

  // a source without maxzoom asks for tiles up to z22. The fixture index keeps detail to z14 (like a real tile
  // server's max zoom); above it the helper used to answer an empty tile, and every feature vanished from zoom 15.
  test('a source WITHOUT maxzoom still has its features at zoom 16', async ({ map, page }) => {
    await page.evaluate(() => {
      const m = (window as any).__geowright_maps.main;
      m.addSource('buildings-nomax', { type: 'vector', tiles: [location.origin + '/vt/buildings/{z}/{x}/{y}.pbf'] });
      m.addLayer({ id: 'buildings-nomax', type: 'fill', source: 'buildings-nomax', 'source-layer': 'buildings', paint: { 'fill-color': '#e91e63' } });
      m.jumpTo({ center: [34.716, 32.1035], zoom: 16 });
    });
    await expect(map).toHaveFeature({ layer: 'buildings-nomax', id: 1013 });
  });
});

/** The route handler itself, without a browser: what it answers for a tile URL. */
test.describe('vectorTileHandler', () => {
  const tileOf = (lng: number, lat: number, z: number) => {
    const n = 2 ** z;
    const r = (lat * Math.PI) / 180;
    return { x: Math.floor(((lng + 180) / 360) * n), y: Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n) };
  };
  const serve = async (url: string) => {
    let res: { status?: number; body?: Buffer | string } = {};
    await vectorTileHandler({ buildings: BUILDINGS })({ request: () => ({ url: () => url }), fulfill: async (r: typeof res) => void (res = r) } as any);
    return { status: res.status, bytes: typeof res.body === 'string' ? res.body.length : res.body?.length ?? 0 };
  };

  test('above the index max zoom (14) a tile is cut from its ancestor, not served empty', async () => {
    for (const z of [14, 15, 16, 20, 22]) {
      const { x, y } = tileOf(34.716, 32.1035, z); // building 1013
      const r = await serve(`http://localhost/vt/buildings/${z}/${x}/${y}.pbf`);
      expect({ z, ...r, empty: r.bytes === 0 }).toEqual({ z, status: 200, bytes: r.bytes, empty: false });
    }
    const { x, y } = tileOf(0, 0, 16); // nothing there: still a valid, empty tile
    expect(await serve(`http://localhost/vt/buildings/16/${x}/${y}.pbf`)).toEqual({ status: 200, bytes: 0 });
  });

  test('retina and double-extension tile URLs are understood', async () => {
    const { x, y } = tileOf(34.716, 32.1035, 12);
    for (const tail of ['.pbf', '@2x.pbf', '.vector.pbf', '.mvt?key=abc', '']) {
      const r = await serve(`http://localhost/vt/buildings/12/${x}/${y}${tail}`);
      expect({ tail, status: r.status, empty: r.bytes === 0 }).toEqual({ tail, status: 200, empty: false });
    }
  });
});
