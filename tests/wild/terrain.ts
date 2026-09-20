import { encodePng } from './png';
import type { Routes } from './harness';

/**
 * SYNTHETIC elevation for terrain examples (real DEM tiles — Mapterhorn, MapTiler — are CC-BY or
 * proprietary and cannot be committed). An analytic landscape in Terrarium encoding, rendered per
 * tile on demand: a plain at 600 m with one east–west ridge (2,400 m) `ridgeNorthKm` north of `center`.
 * Deterministic, a few ms per tile, nothing on disk. Knowing the function, a test knows what hides what.
 */
export function syntheticTerrain(tilejsonUrl: string, center: [number, number], o: { ridgeNorthKm?: number } = {}): Routes {
  const tiles = tilejsonUrl.replace(/[^/]*$/, 'synthetic-dem/{z}/{x}/{y}.png');
  const cache = new Map<string, Buffer>();
  const height = elevation(center, o.ridgeNorthKm ?? 6);
  return [
    [tilejsonUrl, { json: { tilejson: '3.0.0', scheme: 'xyz', tiles: [tiles], bounds: [-180, -85.0511287, 180, 85.0511287], minzoom: 0, maxzoom: 12, encoding: 'terrarium', tileSize: 256 } }],
    [
      new RegExp('^' + tiles.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\\{z\\}/\\{x\\}/\\{y\\}', '(\\d+)/(\\d+)/(\\d+)')),
      (route) => {
        const [, z, x, y] = /\/(\d+)\/(\d+)\/(\d+)\.png/.exec(route.request().url())!.map(Number);
        const key = `${z}/${x}/${y}`;
        let body = cache.get(key);
        if (!body) cache.set(key, (body = demTile(z, x, y, height)));
        return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, contentType: 'image/png', body });
      },
    ],
  ];
}

/** Metres above sea level at a location. */
export function elevation(center: [number, number], ridgeNorthKm: number) {
  return (lng: number, lat: number): number => {
    const northKm = (lat - center[1]) * 111.32;
    const eastKm = (lng - center[0]) * 111.32 * Math.cos((center[1] * Math.PI) / 180);
    const ridge = Math.exp(-(((northKm - ridgeNorthKm) / 1.5) ** 2)) * (0.75 + 0.25 * Math.cos(eastKm / 2));
    return 600 + 1800 * ridge;
  };
}

function demTile(z: number, x: number, y: number, height: (lng: number, lat: number) => number): Buffer {
  const n = 2 ** z, size = 256;
  const lngs = Array.from({ length: size }, (_, i) => ((x + (i + 0.5) / size) / n) * 360 - 180);
  const lats = Array.from({ length: size }, (_, j) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + (j + 0.5) / size)) / n))) * 180) / Math.PI);
  return encodePng(size, size, (i, j) => {
    const v = height(lngs[i], lats[j]) + 32768; // terrarium: h = R*256 + G + B/256 - 32768
    return [Math.floor(v / 256), Math.floor(v % 256), Math.floor((v % 1) * 256), 255];
  });
}
