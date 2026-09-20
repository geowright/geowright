import type { Page } from '@playwright/test';
import { GeoJSONVT } from '@maplibre/geojson-vt';
import { fromGeojsonVt } from '@maplibre/vt-pbf';

/**
 * Deterministic vector tiles without a tile server: serve a GeoJSON fixture as real MVT tiles,
 * cut on the fly inside page.route. The app under test keeps its production-shaped
 * `.../{z}/{x}/{y}.pbf` URL template and its real vector-tile code path.
 *
 *   await routeVectorTiles(page, '**\/vt/buildings/**', { buildings: buildingsGeoJSON });
 *
 * Keys of `layers` are the MVT source-layer names. Feature ids must be integers (MVT limitation).
 */
export async function routeVectorTiles(
  page: Page,
  urlPattern: string | RegExp,
  layers: Record<string, GeoJSON.FeatureCollection>,
  opts: { maxZoom?: number } = {},
): Promise<void> {
  const indexes = Object.entries(layers).map(([name, data]) => [name, new GeoJSONVT(data, { maxZoom: opts.maxZoom ?? 14, indexMaxZoom: 5, buffer: 64 })] as const);
  await page.route(urlPattern, (route) => {
    const m = /\/(\d+)\/(\d+)\/(\d+)(?:\.\w+)?(?:\?.*)?$/.exec(route.request().url());
    if (!m) return route.fulfill({ status: 400, body: 'expected .../{z}/{x}/{y}.pbf' });
    const [z, x, y] = [+m[1], +m[2], +m[3]];
    const tiles: Record<string, NonNullable<ReturnType<GeoJSONVT['getTile']>>> = {};
    for (const [name, index] of indexes) {
      const t = index.getTile(z, x, y);
      if (t) tiles[name] = t;
    }
    // An empty 200 is a valid "nothing here" tile; a 404 would surface as a map error event.
    const body = Object.keys(tiles).length ? Buffer.from(fromGeojsonVt(tiles, { version: 2, extent: 4096 })) : Buffer.alloc(0);
    return route.fulfill({ status: 200, contentType: 'application/x-protobuf', body });
  });
}
