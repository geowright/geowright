import type { Feature, FeatureCollection } from 'geojson';
import { vectorTileHandler } from '../../src/playwright/tiles';
import { glyphs, rasterTiles, type Routes } from './harness';
import { makeSprite } from './png';

/**
 * A SYNTHETIC stand-in for the OpenFreeMap "bright" basemap that most MapLibre examples load.
 *
 * Why synthetic: the real thing is OpenStreetMap data (ODbL) drawn with a CC-BY design — neither may
 * be committed here (permissive licenses only), and tests must not touch the network anyway. What an
 * app depends on is the CONTRACT, and that is reproduced: the same URLs, the OpenMapTiles source
 * name and source-layers (`building` with render_height, `transportation`, `poi`, `place`, …), the
 * well-known layer ids examples refer to (`water`, `building`, `poi_r1`, …), sprite and glyphs. The
 * style below, the colours and the "city" are written for this repo; nothing is copied.
 *
 * The city is generated around `center` (apps look at different places): a street grid, 400
 * buildings with heights, a lake, a park, POIs with icons + names, place labels. Real MVT tiles are cut
 * from it on the fly — the app runs its real vector-tile code path.
 */
export const POI_CLASSES = ['restaurant', 'cafe', 'bar', 'museum', 'school', 'hospital', 'bank', 'shop', 'theatre', 'music', 'bicycle', 'bus', 'park', 'library', 'hotel', 'fuel'];

export function brightBasemap(center: [number, number], o: { icons?: string[] } = {}): Routes {
  const sprite = makeSprite([...new Set([...POI_CLASSES, 'oneway', 'circle', 'star', 'marker', ...(o.icons ?? [])])]);
  const city = syntheticCity(center);
  return [
    ['https://tiles.openfreemap.org/styles/bright', { json: brightStyle() }],
    ['https://tiles.openfreemap.org/planet', { json: { tilejson: '3.0.0', tiles: ['https://tiles.openfreemap.org/planet/synthetic/{z}/{x}/{y}.pbf'], minzoom: 0, maxzoom: 14, bounds: [-180, -85, 180, 85], vector_layers: Object.keys(city).map((id) => ({ id, fields: {} })) } }],
    [/^https:\/\/tiles\.openfreemap\.org\/planet\/synthetic\/\d+\/\d+\/\d+\.pbf/, vectorTileHandler(city)],
    [/^https:\/\/tiles\.openfreemap\.org\/sprites\/ofm_f384\/ofm(@2x)?\.json/, { json: sprite.json }],
    [/^https:\/\/tiles\.openfreemap\.org\/sprites\/ofm_f384\/ofm(@2x)?\.png/, { body: sprite.png, contentType: 'image/png' }],
    glyphs(/^https:\/\/tiles\.openfreemap\.org\/fonts\//),
    rasterTiles(/^https:\/\/tiles\.openfreemap\.org\/natural_earth\//),
  ];
}

/** The synthetic bright basemap answering for MapTiler's hosted "streets-v2" style (proprietary; vue-maplibre-gl's docs use it with a demo key). */
export function maptilerStreetsBasemap(center: [number, number]): Routes {
  return [[/^https:\/\/api\.maptiler\.com\/maps\/streets-v2\/style\.json/, { json: brightStyle() }], ...brightBasemap(center).slice(1)];
}

/**
 * The same synthetic city behind CARTO's hosted basemap styles (positron / dark-matter / voyager), which
 * the react-map-gl examples use. Their real styles and tiles are CARTO's (OSM data, CARTO terms): not
 * committable. Reproduced contract: the style URL, a vector source, glyphs, and the layer ids apps insert
 * their own layers before (`waterway_label` — react-map-gl's `filter` example does `beforeId="waterway_label"`,
 * and with a style lacking that id MapLibre throws and the map never loads: found by the vendoring smoke test).
 */
export function cartoBasemap(name: 'positron' | 'dark-matter' | 'voyager', center: [number, number]): Routes {
  const dark = name === 'dark-matter';
  const base = brightStyle();
  const recolour: Record<string, string> = dark ? { background: '#0e0e0e', water: '#2c353c', park: '#16201a', 'landuse-residential': '#141414', building: '#1d1d1d', 'building-top': '#232323' } : {};
  const layers = base.layers
    .filter((l: any) => l.id !== 'natural_earth' && !/^poi_|^road_oneway/.test(l.id)) // no sprite in these styles
    .map((l: any) => {
      const out = { ...l, ...(l.source ? { source: 'carto' } : {}) };
      if (l.id === 'water_name_point_label') out.id = 'waterway_label';
      const c = recolour[l.id];
      if (c) out.paint = { ...l.paint, [l.type === 'background' ? 'background-color' : 'fill-color']: c };
      if (dark && l.type === 'symbol') out.paint = { ...l.paint, 'text-color': '#cfcfcf', 'text-halo-color': 'rgba(0,0,0,0.8)' };
      return out;
    });
  const host = 'https://tiles.basemaps.cartocdn.com';
  return [
    [`https://basemaps.cartocdn.com/gl/${name}-gl-style/style.json`, { json: { version: 8, name: `geowright synthetic ${name}`, sources: { carto: { type: 'vector', url: `${host}/vector/carto.streets/v1/tiles.json` } }, glyphs: `${host}/fonts/{fontstack}/{range}.pbf`, layers } }],
    [`${host}/vector/carto.streets/v1/tiles.json`, { json: { tilejson: '2.2.0', tiles: [`${host}/vector/carto.streets/v1/synthetic/{z}/{x}/{y}.mvt`], minzoom: 0, maxzoom: 14, bounds: [-180, -85, 180, 85] } }],
    [/^https:\/\/tiles\.basemaps\.cartocdn\.com\/vector\/carto\.streets\/v1\/synthetic\/\d+\/\d+\/\d+\.mvt/, vectorTileHandler(syntheticCity(center))],
    glyphs(/^https:\/\/tiles\.basemaps\.cartocdn\.com\/fonts\//),
  ];
}

/** Metres east/north of `center` -> [lng, lat]. */
const offset = (center: [number, number]) => (x: number, y: number): [number, number] => [center[0] + x / (111_320 * Math.cos((center[1] * Math.PI) / 180)), center[1] + y / 111_320];

export function syntheticCity(center: [number, number]): Record<string, FeatureCollection> {
  const at = offset(center);
  let id = 1;
  const f = (geometry: Feature['geometry'], properties: Record<string, unknown>): Feature => ({ type: 'Feature', id: id++, geometry, properties });
  const box = (x0: number, y0: number, x1: number, y1: number): Feature['geometry'] => ({ type: 'Polygon', coordinates: [[at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1), at(x0, y0)]] });
  const line = (...pts: [number, number][]): Feature['geometry'] => ({ type: 'LineString', coordinates: pts.map(([x, y]) => at(x, y)) });
  const rand = mulberry32(20260920);

  const building: Feature[] = [];
  for (let bx = -5; bx < 5; bx++) {
    for (let by = -5; by < 5; by++) {
      for (const [dx, dy] of [[12, 12], [68, 12], [12, 68], [68, 68]]) {
        const x = bx * 120 + dx, y = by * 120 + dy;
        building.push(f(box(x, y, x + 40, y + 40), { render_height: Math.round(6 + rand() * 84), render_min_height: 0, colour: '#d9d0c9' }));
      }
    }
  }

  const transportation: Feature[] = [];
  const transportation_name: Feature[] = [];
  const road = (cls: string, name: string, ...pts: [number, number][]) => {
    transportation.push(f(line(...pts), { class: cls, oneway: cls === 'primary' ? 1 : 0 }));
    transportation_name.push(f(line(...pts), { class: cls, name, 'name:latin': name }));
  };
  for (let i = -10; i <= 10; i++) {
    if (i === 0) continue;
    road('minor', `${Math.abs(i)}${i < 0 ? ' West' : ' East'} Street`, [i * 120, -1200], [i * 120, 1200]);
    road('minor', `${Math.abs(i)}${i < 0 ? ' South' : ' North'} Avenue`, [-1200, i * 120], [1200, i * 120]);
  }
  road('primary', 'Meridian Road', [0, -3000], [0, 3000]);
  road('primary', 'Parallel Road', [-3000, 0], [3000, 0]);
  road('motorway', 'Ring Motorway', [-3000, -1500], [3000, -1500]);
  transportation.push(f(line([-3000, 1500], [3000, 1500]), { class: 'rail' }));

  const poi: Feature[] = [];
  POI_CLASSES.forEach((cls, i) => {
    const bx = (i % 4) - 2, by = Math.floor(i / 4) - 2;
    poi.push(f({ type: 'Point', coordinates: at(bx * 240 + 60, by * 240 + 60) }, { class: cls, subclass: cls, name: `${cls[0].toUpperCase()}${cls.slice(1)} ${i + 1}`, rank: i + 1 }));
  });

  const place: Feature[] = [
    f({ type: 'Point', coordinates: at(0, 300) }, { class: 'city', name: 'Wrightville', 'name:latin': 'Wrightville', rank: 1, capital: 2 }),
    ...(['Northam', 'Eastford', 'Southby', 'Westerleigh'] as const).map((name, i) =>
      f({ type: 'Point', coordinates: at([0, 9000, 0, -9000][i], [9000, 0, -9000, 0][i]) }, { class: 'town', name, 'name:latin': name, rank: 10 }),
    ),
  ];

  const fc = (features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });
  return {
    water: fc([f(box(1300, -900, 2600, 900), { class: 'lake' })]),
    water_name: fc([f({ type: 'Point', coordinates: at(1950, 0) }, { class: 'lake', name: 'Lake Fixture', 'name:latin': 'Lake Fixture' })]),
    park: fc([f(box(-2400, -600, -1300, 600), { class: 'public_park', name: 'Harness Park' })]),
    landuse: fc([f(box(-1250, -1250, 1250, 1250), { class: 'residential' })]),
    building: fc(building),
    transportation: fc(transportation),
    transportation_name: fc(transportation_name),
    poi: fc(poi),
    place: fc(place),
  };
}

/** Our own style with the bright basemap's contract (source, source-layers, the layer ids examples rely on). */
export function brightStyle() {
  const src = (sourceLayer: string) => ({ source: 'openmaptiles', 'source-layer': sourceLayer });
  const cls = (...c: string[]) => ['match', ['get', 'class'], c, true, false];
  const font = ['Noto Sans Regular'];
  const roadLayers = (['minor', 'primary', 'motorway'] as const).flatMap((c, i) => [
    { id: `highway-${c}-casing`, type: 'line', ...src('transportation'), filter: cls(c), layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#c9c2b8', 'line-width': ['interpolate', ['exponential', 1.4], ['zoom'], 8, 1 + i, 18, 14 + 8 * i] } },
    { id: `highway-${c}`, type: 'line', ...src('transportation'), filter: cls(c), layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['#ffffff', '#fdf0b5', '#f6b26b'][i], 'line-width': ['interpolate', ['exponential', 1.4], ['zoom'], 8, 0.5 + i, 18, 11 + 8 * i] } },
  ]);
  const poi = (id: string, maxRank: number, minzoom: number) => ({
    id, type: 'symbol', ...src('poi'), minzoom, filter: ['<=', ['get', 'rank'], maxRank],
    layout: { 'icon-image': ['get', 'class'], 'text-field': ['get', 'name'], 'text-font': font, 'text-size': 11, 'text-anchor': 'top', 'text-offset': [0, 0.9], 'text-optional': true },
    paint: { 'text-color': '#5d4a3a', 'text-halo-color': '#ffffff', 'text-halo-width': 1 },
  });
  const label = (id: string, c: string, size: number) => ({
    id, type: 'symbol', ...src('place'), filter: cls(c),
    layout: { 'text-field': ['coalesce', ['get', 'name:latin'], ['get', 'name']], 'text-font': font, 'text-size': size, 'text-max-width': 8 },
    paint: { 'text-color': '#2b2b2b', 'text-halo-color': 'rgba(255,255,255,0.85)', 'text-halo-width': 1.4 },
  });
  return {
    version: 8,
    name: 'geowright synthetic bright (OpenMapTiles contract, own design)',
    sources: {
      ne2_shaded: { type: 'raster', maxzoom: 6, tileSize: 256, tiles: ['https://tiles.openfreemap.org/natural_earth/ne2sr/{z}/{x}/{y}.png'] },
      openmaptiles: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' },
    },
    sprite: 'https://tiles.openfreemap.org/sprites/ofm_f384/ofm',
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#f4f1ea' } },
      { id: 'natural_earth', type: 'raster', source: 'ne2_shaded', maxzoom: 7, paint: { 'raster-opacity': 0.4 } },
      { id: 'landuse-residential', type: 'fill', ...src('landuse'), filter: cls('residential'), paint: { 'fill-color': '#ece7df' } },
      { id: 'park', type: 'fill', ...src('park'), paint: { 'fill-color': '#cfe6b8' } },
      { id: 'water', type: 'fill', ...src('water'), paint: { 'fill-color': '#a9cdf0' } },
      { id: 'building', type: 'fill', ...src('building'), minzoom: 13, paint: { 'fill-color': '#ded6cc', 'fill-antialias': true } },
      { id: 'building-top', type: 'fill', ...src('building'), minzoom: 13, paint: { 'fill-color': '#ebe4da', 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 13, 0, 16, 1], 'fill-outline-color': '#cfc6ba' } },
      ...roadLayers,
      { id: 'railway', type: 'line', ...src('transportation'), filter: cls('rail'), paint: { 'line-color': '#9a9a9a', 'line-width': 1.5, 'line-dasharray': [3, 3] } },
      { id: 'road_oneway', type: 'symbol', ...src('transportation'), minzoom: 15, filter: ['==', ['get', 'oneway'], 1], layout: { 'symbol-placement': 'line', 'icon-image': 'oneway', 'icon-size': 0.5, 'symbol-spacing': 200 } },
      { id: 'water_name_point_label', type: 'symbol', ...src('water_name'), layout: { 'text-field': ['get', 'name'], 'text-font': font, 'text-size': 12 }, paint: { 'text-color': '#38619c', 'text-halo-color': 'rgba(255,255,255,0.7)', 'text-halo-width': 1 } },
      poi('poi_r20', 16, 16),
      poi('poi_r7', 8, 14),
      poi('poi_r1', 3, 12),
      { id: 'highway-name-minor', type: 'symbol', ...src('transportation_name'), minzoom: 15, filter: cls('minor'), layout: { 'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-font': font, 'text-size': 11 }, paint: { 'text-color': '#6b6b6b', 'text-halo-color': '#ffffff', 'text-halo-width': 1 } },
      { id: 'highway-name-major', type: 'symbol', ...src('transportation_name'), minzoom: 12, filter: cls('primary', 'motorway'), layout: { 'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-font': font, 'text-size': 12 }, paint: { 'text-color': '#4a4a4a', 'text-halo-color': '#ffffff', 'text-halo-width': 1 } },
      label('label_town', 'town', 13),
      label('label_city', 'city', 16),
    ],
  };
}

function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
