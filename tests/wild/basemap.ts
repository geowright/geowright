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

/**
 * `dense: true` — label density and layer count closer to a REAL basemap (opt-in, so that the specs written against
 * the sparse city keep meaning what they meant): ~400 named POIs in three rank tiers, a house number on every
 * building, neighbourhood labels, street names from zoom 13, and a style of 60+ layers (landcover / landuse
 * classes, tunnel / bridge / casing variants, one label layer per place class) instead of ~25. All generated here;
 * nothing is copied from any real style or dataset. It exists for ONE question: what happens to an app's features
 * when basemap LABELS are drawn on top of them — which is where an app that inserts its layers "below the labels"
 * (the recommended practice, and what MapLibre's 3D-buildings example does) really lives.
 */
export function brightBasemap(center: [number, number], o: { icons?: string[]; dense?: boolean } = {}): Routes {
  const sprite = makeSprite([...new Set([...POI_CLASSES, 'oneway', 'circle', 'star', 'marker', ...(o.icons ?? [])])]);
  const city = syntheticCity(center, o.dense);
  return [
    ['https://tiles.openfreemap.org/styles/bright', { json: brightStyle(o.dense) }],
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

export function syntheticCity(center: [number, number], dense = false): Record<string, FeatureCollection> {
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

  const housenumber: Feature[] = [];
  const landcover: Feature[] = [];
  if (dense) {
    // a named POI in (almost) every block corner and mid-block, ranks spread so that every tier has plenty
    const words = ['Corner', 'Old', 'Little', 'Grand', 'Blue', 'Green', 'Union', 'Market', 'Harbour', 'Station', 'Garden', 'Royal'];
    let n = POI_CLASSES.length;
    for (let bx = -5; bx < 5; bx++) {
      for (let by = -5; by < 5; by++) {
        for (const [dx, dy] of [[6, 60], [60, 6], [60, 114], [114, 60]]) {
          const cls = POI_CLASSES[Math.floor(rand() * POI_CLASSES.length)];
          n++;
          poi.push(f({ type: 'Point', coordinates: at(bx * 120 + dx, by * 120 + dy) }, { class: cls, subclass: cls, name: `${words[n % words.length]} ${cls[0].toUpperCase()}${cls.slice(1)} ${n}`, rank: 1 + (n % 30) }));
        }
      }
    }
    building.forEach((b, i) => {
      const ring = (b.geometry as any).coordinates[0] as [number, number][];
      housenumber.push(f({ type: 'Point', coordinates: [(ring[0][0] + ring[2][0]) / 2, (ring[0][1] + ring[2][1]) / 2] }, { housenumber: String(1 + ((i * 7) % 240)) }));
    });
    ['Foundry', 'Saltmarsh', 'Kiln Hill', 'Weavers', 'Tanners Row', 'Orchard', 'Lockside', 'Millrace', 'Cooperage'].forEach((name, i) =>
      place.push(f({ type: 'Point', coordinates: at(((i % 3) - 1) * 420, (Math.floor(i / 3) - 1) * 420) }, { class: i % 2 ? 'neighbourhood' : 'suburb', name, 'name:latin': name, rank: 12 + i })),
    );
    landcover.push(f(box(-2400, 700, -1300, 1250), { class: 'wood' }), f(box(1300, 950, 2600, 1250), { class: 'grass' }), f(box(-2400, -1250, -1300, -700), { class: 'sand' }));
  }

  const fc = (features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });
  return {
    ...(dense ? { housenumber: fc(housenumber), landcover: fc(landcover) } : {}),
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
export function brightStyle(dense = false) {
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
  if (dense) return denseStyle({ src, cls, font, roadLayers, poi, label });
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

/**
 * The dense variant: same contract and the same well-known ids (`water`, `building`, `poi_r1`, `label_city`, …) in
 * the same relative order, with what a production style adds around them. Own work; the layer ids that are not part
 * of the contract are ordinary descriptive names, not a copy of any style's list.
 */
function denseStyle(h: { src: (l: string) => any; cls: (...c: string[]) => any; font: string[]; roadLayers: any[]; poi: (id: string, maxRank: number, minzoom: number) => any; label: (id: string, c: string, size: number) => any }) {
  const { src, cls, font } = h;
  const base: any = brightStyle(false);
  const byId = (id: string) => base.layers.find((l: any) => l.id === id);
  const fill = (id: string, layer: string, c: string, colour: string) => ({ id, type: 'fill', ...src(layer), filter: cls(c), paint: { 'fill-color': colour } });
  const variants = (['minor', 'primary', 'motorway'] as const).flatMap((c) =>
    (['tunnel', 'bridge'] as const).flatMap((brunnel) => [
      { id: `${brunnel}-${c}-casing`, type: 'line', ...src('transportation'), filter: ['all', cls(c), ['==', ['get', 'brunnel'], brunnel]], paint: { 'line-color': '#b8b0a4', 'line-width': 3 } },
      { id: `${brunnel}-${c}`, type: 'line', ...src('transportation'), filter: ['all', cls(c), ['==', ['get', 'brunnel'], brunnel]], paint: { 'line-color': '#fff', 'line-width': 2 } },
    ]),
  );
  const poiTier = (id: string, lo: number, hi: number, minzoom: number) => ({ ...h.poi(id, hi, minzoom), filter: ['all', ['>', ['get', 'rank'], lo], ['<=', ['get', 'rank'], hi]] });
  const text = (id: string, layer: string, field: any, size: number, minzoom: number, extra: any = {}) => ({
    id, type: 'symbol', ...src(layer), minzoom, ...extra,
    layout: { 'text-field': field, 'text-font': font, 'text-size': size, ...(extra.layout ?? {}) },
    paint: { 'text-color': '#4a4a4a', 'text-halo-color': 'rgba(255,255,255,0.85)', 'text-halo-width': 1.2 },
  });
  const layers = [
    byId('background'), byId('natural_earth'),
    fill('landcover-wood', 'landcover', 'wood', '#b9d6a3'), fill('landcover-grass', 'landcover', 'grass', '#d8ebc4'), fill('landcover-sand', 'landcover', 'sand', '#f0e6c0'),
    fill('landcover-ice', 'landcover', 'ice', '#eef5f8'), fill('landcover-wetland', 'landcover', 'wetland', '#cfe0d2'),
    byId('landuse-residential'),
    ...['commercial', 'industrial', 'cemetery', 'hospital', 'school', 'stadium', 'pitch', 'railway'].map((c) => fill(`landuse-${c}`, 'landuse', c, '#e6e0d6')),
    byId('park'),
    { id: 'park-outline', type: 'line', ...src('park'), paint: { 'line-color': '#a9cf8a', 'line-dasharray': [2, 2] } },
    byId('water'),
    { id: 'water-outline', type: 'line', ...src('water'), paint: { 'line-color': '#8bb6e0' } },
    { id: 'waterway-river', type: 'line', ...src('waterway'), filter: cls('river'), paint: { 'line-color': '#a9cdf0', 'line-width': 2 } },
    { id: 'waterway-stream', type: 'line', ...src('waterway'), filter: cls('stream', 'canal'), paint: { 'line-color': '#a9cdf0' } },
    { id: 'aeroway-area', type: 'fill', ...src('aeroway'), paint: { 'fill-color': '#e3e0ea' } },
    { id: 'aeroway-runway', type: 'line', ...src('aeroway'), filter: cls('runway'), paint: { 'line-color': '#d0cbe0', 'line-width': 4 } },
    byId('building'), byId('building-top'),
    ...variants.filter((l) => l.id.startsWith('tunnel')),
    ...h.roadLayers,
    { id: 'highway-path', type: 'line', ...src('transportation'), filter: cls('path', 'track'), paint: { 'line-color': '#cba', 'line-dasharray': [1, 1] } },
    byId('railway'),
    { id: 'railway-hatching', type: 'line', ...src('transportation'), filter: cls('rail'), paint: { 'line-color': '#9a9a9a', 'line-width': 5, 'line-dasharray': [0.2, 4] } },
    ...variants.filter((l) => l.id.startsWith('bridge')),
    { id: 'boundary-3', type: 'line', ...src('boundary'), filter: ['>=', ['get', 'admin_level'], 3], paint: { 'line-color': '#9e9cab', 'line-dasharray': [4, 2] } },
    { id: 'boundary-2', type: 'line', ...src('boundary'), filter: ['==', ['get', 'admin_level'], 2], paint: { 'line-color': '#8d8b9d', 'line-width': 1.5 } },
    // ---- labels: everything below is a symbol layer, as in a production style ----
    byId('road_oneway'),
    text('housenumber', 'housenumber', ['get', 'housenumber'], 10, 15),
    byId('water_name_point_label'),
    text('waterway-name', 'waterway', ['get', 'name'], 11, 13, { layout: { 'symbol-placement': 'line' } }),
    text('park-name', 'park', ['get', 'name'], 12, 12),
    poiTier('poi_r20', 14, 30, 15), poiTier('poi_r7', 6, 14, 15), poiTier('poi_r1', 0, 6, 14),
    { ...byId('highway-name-minor'), minzoom: 14 }, byId('highway-name-major'),
    text('highway-shield', 'transportation_name', ['get', 'ref'], 10, 10, { filter: ['has', 'ref'] }),
    text('airport-label', 'aerodrome_label', ['get', 'name'], 11, 10),
    h.label('label_neighbourhood', 'neighbourhood', 11), h.label('label_suburb', 'suburb', 12), h.label('label_village', 'village', 12),
    byId('label_town'), byId('label_city'),
    h.label('label_state', 'state', 13), h.label('label_country_3', 'country', 13), h.label('label_country_2', 'country', 15), h.label('label_country_1', 'country', 17),
  ];
  return { ...base, name: 'geowright synthetic bright, dense (OpenMapTiles contract, own design)', layers };
}

function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
