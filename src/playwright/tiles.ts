import type { Page, Route } from '@playwright/test';
import type { FeatureCollection } from 'geojson';
import { GeoJSONVT, geoJSONToTile } from '@maplibre/geojson-vt';
import { fromGeojsonVt } from '@maplibre/vt-pbf';

/**
 * Deterministic vector tiles without a tile server: serve a GeoJSON fixture as real MVT tiles,
 * cut on the fly inside page.route. The app under test keeps its production-shaped
 * `.../{z}/{x}/{y}.pbf` URL template and its real vector-tile code path.
 *
 *   await routeVectorTiles(page, '**\/vt/buildings/**', { buildings: buildingsGeoJSON });
 *
 * Keys of `layers` are the MVT source-layer names. Feature ids must be integers (MVT limitation).
 *
 * `maxZoom` (default 14) is the zoom up to which detail is kept, like a tile server's max zoom. A source WITHOUT
 * `maxzoom` makes MapLibre request tiles up to z22: above `maxZoom` a tile is cut from the same data at `maxZoom`
 * detail (overzoom), so features stay. Setting `maxzoom` on the source is still better: MapLibre then overzooms
 * the z14 tiles itself instead of requesting a tile per zoom level.
 * Understood URLs end in `/{z}/{x}/{y}`, optionally `@2x`, any extension(s) (`.pbf`, `.mvt`, `.vector.pbf`) and a query.
 * The tile URL may be on another origin, and the app's tile requests may carry credentials (`credentials: 'include'`).
 *
 * `scheme` (default `'xyz'`) must match the source's own `scheme`. A source with `scheme: 'tms'` (a TMS tile server)
 * counts rows from the south, so MapLibre asks for row 2^z - 1 - y: read as `'xyz'`, that is the mirrored band of the
 * world, and the layer draws that band's features in the wrong place, or nothing where the fixture has no data there.
 */
export async function routeVectorTiles(
  page: Page,
  urlPattern: string | RegExp,
  layers: Record<string, FeatureCollection>,
  opts: { maxZoom?: number; scheme?: 'xyz' | 'tms' } = {},
): Promise<void> {
  await page.route(urlPattern, vectorTileHandler(layers, opts));
}

/**
 * The same thing as a plain route handler, for when you register routes yourself
 * (`context.route`, a routing table, a handler that falls back for some tiles).
 */
export function vectorTileHandler(layers: Record<string, FeatureCollection>, opts: { maxZoom?: number; scheme?: 'xyz' | 'tms' } = {}): (route: Route) => Promise<void> {
  const maxZoom = opts.maxZoom ?? 14;
  const scheme = opts.scheme ?? 'xyz';
  // a typo ('TMS') would otherwise read every tile as xyz, and a tms layer would silently draw the mirrored band (or nothing)
  if (scheme !== 'xyz' && scheme !== 'tms') throw new Error(`vectorTileHandler: scheme must be 'xyz' or 'tms' (the source's own scheme), got ${JSON.stringify(scheme)}`);
  const indexes = Object.entries(layers).map(([name, data]) => [name, data, new GeoJSONVT(data, { maxZoom, indexMaxZoom: 5, buffer: 64 })] as const);
  return (route) => {
    const m = /\/(\d+)\/(\d+)\/(\d+)(?:@\d+(?:\.\d+)?x)?(?:\.[\w-]+)*(?:[?#].*)?$/.exec(route.request().url());
    if (!m) return route.fulfill({ status: 400, body: 'expected .../{z}/{x}/{y}[@2x][.pbf]' });
    const z = +m[1], x = +m[2];
    const y = scheme === 'tms' ? 2 ** z - 1 - +m[3] : +m[3]; // TMS rows count from the south
    const tiles: Record<string, NonNullable<ReturnType<GeoJSONVT['getTile']>>> = {};
    for (const [name, data, index] of indexes) {
      // Above maxZoom the index has no tiles (getTile answers null): cut this one tile from the data directly, simplified
      // to maxZoom detail as the index is. (it used to be an empty tile, so every feature vanished past z14.)
      const t = z <= maxZoom ? index.getTile(z, x, y) : geoJSONToTile(data, z, x, y, { maxZoom, buffer: 64, clip: true, wrap: true });
      if (t && t.features.length) tiles[name] = t;
    }
    // An empty 200 is a valid "nothing here" tile; a 404 would surface as a map error event.
    const body = Object.keys(tiles).length ? Buffer.from(fromGeojsonVt(tiles, { version: 2, extent: 4096 })) : Buffer.alloc(0);
    // No CORS header of our own: for a cross-origin request, route.fulfill answers with the request's own origin,
    // `access-control-allow-credentials: true` and `vary: Origin` (read in Playwright 1.49.0, the peer floor, and 1.63.0),
    // unless the response already names an origin. The `*` this used to send switched that off, and a browser rejects
    // `*` for a request with credentials: an app whose tile requests carry cookies got no tiles at all.
    return route.fulfill({ status: 200, contentType: 'application/x-protobuf', body });
  };
}
