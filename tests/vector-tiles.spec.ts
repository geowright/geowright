import { test, expect } from './fixtures';
import { BUILDINGS } from './buildings';
import { routeVectorTiles, vectorTileHandler } from '../src/playwright/tiles';
import { FAIL_FAST_MS } from './slow-machine';

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
    const err = await far.click({ timeout: FAIL_FAST_MS }).then(() => null, (e: Error) => e);
    expect(err?.message).toContain('uses a tiled (vector) source');
    expect(err?.message).toContain('{ autoPan: { lng, lat } }');

    // `autoPan: true` has nothing to look up for tiles: same clear failure, not a hang or a wrong click
    const err2 = await far.click({ timeout: FAIL_FAST_MS, autoPan: true }).then(() => null, (e: Error) => e);
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

/**
 * A production tile server is usually on another origin, and one that authenticates with cookies needs the app's tile
 * requests to carry credentials (`transformRequest` → `credentials: 'include'`). A browser rejects
 * `access-control-allow-origin: *` for a credentialed request; the helper used to send exactly that, so such an app got
 * no tiles at all. The host below is never reached: page.route answers it, and the fixtures' network guard aborts
 * anything else.
 */
test.describe('tiles on another origin', () => {
  const HOST = 'https://tiles.geowright-test.invalid';
  for (const credentials of [undefined, 'include'] as const) {
    test(`the app's tile requests ${credentials ? 'carry credentials' : 'carry no credentials'}`, async ({ map, page }) => {
      const failed: string[] = [];
      page.on('requestfailed', (r) => void (r.url().startsWith(HOST) && failed.push(`${r.failure()?.errorText} ${r.url().slice(HOST.length)}`)));
      await routeVectorTiles(page, `${HOST}/**`, { buildings: BUILDINGS });
      await page.evaluate(({ host, credentials }) => {
        const m = (window as any).__geowright_maps.main;
        if (credentials) m.setTransformRequest((url: string) => (url.startsWith(host) ? { url, credentials } : { url }));
        m.addSource('remote', { type: 'vector', tiles: [`${host}/vt/{z}/{x}/{y}.pbf`], maxzoom: 14 });
        m.addLayer({ id: 'remote', type: 'fill', source: 'remote', 'source-layer': 'buildings', paint: { 'fill-color': '#e91e63' } });
      }, { host: HOST, credentials });
      // a tile the browser rejects reads as "no features here": say which requests failed, not only that 0 were found
      await expect(map.features({ layer: 'remote' })).toHaveFeatureCount(25).catch((e: Error) => {
        throw new Error(`${e.message}\n\nfailed tile requests: ${failed.slice(0, 3).join(', ') || 'none'}`);
      });
    });
  }
});

/**
 * A vector source may declare `scheme: 'tms'` (a TMS tile server: rows counted from the south). MapLibre then asks for
 * row 2^z - 1 - y of the same template, and a helper that reads every URL as XYZ cuts the mirrored row of the world:
 * these buildings, all in one city, drew nothing, so a positive assertion failed and a `.not` on it passed whatever the
 * data. A fixture with data in the mirrored band draws that band's features in the wrong place instead (tested below).
 * `{ scheme: 'tms' }` reads the row the way the source asks for it.
 */
test.describe('a TMS vector source', () => {
  test(`served with { scheme: 'tms' } it shows the same buildings as an xyz source`, async ({ map, page }) => {
    await routeVectorTiles(page, '**/vt-tms/buildings/**', { buildings: BUILDINGS }, { scheme: 'tms' });
    await page.evaluate(() => {
      const m = (window as any).__geowright_maps.main;
      m.addSource('b-tms', { type: 'vector', scheme: 'tms', maxzoom: 14, tiles: [location.origin + '/vt-tms/buildings/{z}/{x}/{y}.pbf'] });
      m.addLayer({ id: 'b-tms', type: 'fill', source: 'b-tms', 'source-layer': 'buildings', paint: { 'fill-color': '#e91e63' } });
    });
    await expect(map.features({ layer: 'b-tms' })).toHaveFeatureCount(25);
    await expect(map).toHaveFeature({ layer: 'b-tms', id: 1013, where: { floors: { gte: 1 } } });
  });
});

/** The route handler itself, without a browser: what it answers for a tile URL. */
test.describe('vectorTileHandler', () => {
  const tileOf = (lng: number, lat: number, z: number) => {
    const n = 2 ** z;
    const r = (lat * Math.PI) / 180;
    return { x: Math.floor(((lng + 180) / 360) * n), y: Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n) };
  };
  const answer = async (url: string, opts?: Parameters<typeof vectorTileHandler>[1], layers: Parameters<typeof vectorTileHandler>[0] = { buildings: BUILDINGS }) => {
    let res: { status?: number; body?: Buffer | string } = {};
    await vectorTileHandler(layers, opts)({ request: () => ({ url: () => url }), fulfill: async (r: typeof res) => void (res = r) } as any);
    return res;
  };
  const serve = async (url: string, opts?: Parameters<typeof vectorTileHandler>[1]) => {
    const res = await answer(url, opts);
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

  test(`{ scheme: 'tms' } reads the row from the south: the TMS URL of a tile gets the XYZ URL's tile`, async () => {
    for (const z of [7, 10, 12, 14, 16]) { // below z7 the buildings are too small to survive simplification: empty tiles
      const { x, y } = tileOf(34.716, 32.1035, z); // building 1013
      const tmsY = 2 ** z - 1 - y;
      const xyz = Buffer.from((await answer(`http://localhost/vt/buildings/${z}/${x}/${y}.pbf`)).body ?? '');
      const tms = await answer(`http://localhost/vt/buildings/${z}/${x}/${tmsY}.pbf`, { scheme: 'tms' });
      const body = Buffer.from(tms.body ?? '');
      expect({ z, status: tms.status, empty: body.length === 0, same: body.equals(xyz) }).toEqual({ z, status: 200, empty: false, same: true });
      // xyz is the default: the same URL read as XYZ is the mirrored row, in the other hemisphere (nothing there)
      expect((await serve(`http://localhost/vt/buildings/${z}/${x}/${tmsY}.pbf`)).bytes).toBe(0);
    }
  });

  test(`a TMS row read as XYZ with a world-wide fixture serves the other hemisphere's features, not an empty tile`, async () => {
    const place = (name: string, lat: number) => ({ type: 'Feature' as const, properties: { name }, geometry: { type: 'Point' as const, coordinates: [34.716, lat] } });
    const world = { places: { type: 'FeatureCollection' as const, features: [place('north', 32.1035), place('south', -32.1035)] } };
    for (const z of [8, 12, 16]) {
      const { x, y } = tileOf(34.716, 32.1035, z); // the northern place's tile, as a scheme: 'tms' source asks for it
      const body = Buffer.from((await answer(`http://localhost/vt/places/${z}/${x}/${2 ** z - 1 - y}.pbf`, undefined, world)).body ?? '');
      // MVT keeps string values verbatim: the names are in the bytes
      expect({ z, north: body.includes('north'), south: body.includes('south') }).toEqual({ z, north: false, south: true });
    }
  });

  test('a scheme other than xyz or tms is an error, not a silent xyz', () => {
    expect(() => vectorTileHandler({ buildings: BUILDINGS }, { scheme: 'TMS' as any })).toThrow(/scheme must be 'xyz' or 'tms'/);
  });

  test('retina and double-extension tile URLs are understood', async () => {
    const { x, y } = tileOf(34.716, 32.1035, 12);
    for (const tail of ['.pbf', '@2x.pbf', '.vector.pbf', '.mvt?key=abc', '']) {
      const r = await serve(`http://localhost/vt/buildings/12/${x}/${y}${tail}`);
      expect({ tail, status: r.status, empty: r.bytes === 0 }).toEqual({ tail, status: 200, empty: false });
    }
  });
});
