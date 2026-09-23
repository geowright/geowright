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
 * DENSE by default (an earlier change): label density measured to be comparable to the real OpenFreeMap "bright" style at the
 * zooms the wild apps look at (tests/wild/basemap-density.spec.ts has the numbers and the measurement). Around the
 * generated city core (street grid, 400 buildings with house numbers, ~400 ranked POIs) lies a generated REGION:
 * suburbs, neighbourhoods, villages and towns every few km out to ±30 km, arterial roads with names and route refs
 * (drawn as road SHIELDS), an orbital motorway and radial motorways, rivers, streams and lakes with names, named parks,
 * rail lines with stations, bus stops, two airports — and further out, cities, states and countries for the low zooms.
 * The style (79 layers, 24 of them symbol layers; the real one has 120 and 25) has what a production style adds around
 * the contract: casings, tunnel / bridge variants, landcover / landuse classes, one label layer per place class, one-way
 * arrows both ways, road shields (sprite icons generated in png.ts, like every other icon here).
 * All generated here, deterministically (fixed seeds: the same bytes every run); nothing is copied from any real style
 * or dataset. Streets are split per block in `transportation` and merged per name in `transportation_name`, as the
 * OpenMapTiles schema does.
 *
 * `dense: false` — the original sparse city (~25 layers, a handful of labels), kept only to measure against.
 */
export function brightBasemap(center: [number, number], o: { icons?: string[]; dense?: boolean } = {}): Routes {
  const dense = o.dense ?? true;
  const sprite = dense
    ? makeSprite([...new Set([...POI_CLASSES, 'oneway', 'circle', 'star', 'marker', 'railway', 'airport', ...(o.icons ?? [])])], 21, { shields: 6 })
    : makeSprite([...new Set([...POI_CLASSES, 'oneway', 'circle', 'star', 'marker', ...(o.icons ?? [])])]);
  const city = syntheticCity(center, dense);
  return [
    ['https://tiles.openfreemap.org/styles/bright', { json: brightStyle(dense) }],
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
  return [[/^https:\/\/api\.maptiler\.com\/maps\/streets-v2\/style\.json/, { json: brightStyle(true) }], ...brightBasemap(center).slice(1)];
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
  const base = brightStyle(true);
  const recolour: Record<string, string> = dark ? { background: '#0e0e0e', water: '#2c353c', park: '#16201a', 'landuse-residential': '#141414', building: '#1d1d1d', 'building-top': '#232323' } : {};
  const layers = base.layers
    .filter((l: any) => l.id !== 'natural_earth' && !l.layout?.['icon-image']) // no sprite in these styles: no icon layers
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
    [/^https:\/\/tiles\.basemaps\.cartocdn\.com\/vector\/carto\.streets\/v1\/synthetic\/\d+\/\d+\/\d+\.mvt/, vectorTileHandler(syntheticCity(center, true))],
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
  if (!dense) {
    for (let i = -10; i <= 10; i++) {
      if (i === 0) continue;
      road('minor', `${Math.abs(i)}${i < 0 ? ' West' : ' East'} Street`, [i * 120, -1200], [i * 120, 1200]);
      road('minor', `${Math.abs(i)}${i < 0 ? ' South' : ' North'} Avenue`, [-1200, i * 120], [1200, i * 120]);
    }
  } else {
    // The same grid as OpenMapTiles has it: `transportation` split at every crossing (one feature per block), the names
    // merged in `transportation_name`. Every fifth street is a secondary road; the minor streets running north-south
    // are one-way, alternating direction, like a downtown grid.
    for (let i = -10; i <= 10; i++) {
      if (i === 0) continue;
      const cls = i % 5 === 0 ? 'secondary' : 'minor';
      const oneway = cls === 'minor' ? (i % 2 ? 1 : -1) : 0;
      const street = `${Math.abs(i)}${i < 0 ? ' West' : ' East'} Street`, avenue = `${Math.abs(i)}${i < 0 ? ' South' : ' North'} Avenue`;
      for (let j = -10; j < 10; j++) {
        transportation.push(f(line([i * 120, j * 120], [i * 120, (j + 1) * 120]), { class: cls, oneway }));
        transportation.push(f(line([j * 120, i * 120], [(j + 1) * 120, i * 120]), { class: cls, oneway: 0 }));
      }
      transportation_name.push(f(line([i * 120, -1200], [i * 120, 1200]), { class: cls, name: street, 'name:latin': street }));
      transportation_name.push(f(line([-1200, i * 120], [1200, i * 120]), { class: cls, name: avenue, 'name:latin': avenue }));
    }
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

  const water: Feature[] = [f(box(1300, -900, 2600, 900), { class: 'lake' })];
  const water_name: Feature[] = [f({ type: 'Point', coordinates: at(1950, 0) }, { class: 'lake', name: 'Lake Fixture', 'name:latin': 'Lake Fixture' })];
  const park: Feature[] = [f(box(-2400, -600, -1300, 600), { class: 'public_park', name: 'Harness Park' })];
  const landuse: Feature[] = [f(box(-1250, -1250, 1250, 1250), { class: 'residential' })];
  const housenumber: Feature[] = [];
  const landcover: Feature[] = [];
  const more: Record<string, Feature[]> = { waterway: [], aeroway: [], aerodrome_label: [], boundary: [] };
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
    syntheticRegion(center, { f, at, box, line }, { transportation, transportation_name, poi, place, water, water_name, park, landuse, landcover, ...more });
  }

  const fc = (features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });
  return {
    ...(dense ? { housenumber: fc(housenumber), landcover: fc(landcover), ...Object.fromEntries(Object.entries(more).map(([k, v]) => [k, fc(v)])) } : {}),
    water: fc(water),
    water_name: fc(water_name),
    park: fc(park),
    landuse: fc(landuse),
    building: fc(building),
    transportation: fc(transportation),
    transportation_name: fc(transportation_name),
    poi: fc(poi),
    place: fc(place),
  };
}

type Draw = {
  f: (geometry: Feature['geometry'], properties: Record<string, unknown>) => Feature;
  at: (x: number, y: number) => [number, number];
  box: (x0: number, y0: number, x1: number, y1: number) => Feature['geometry'];
  line: (...pts: [number, number][]) => Feature['geometry'];
};

/**
 * Everything around the city core, for the dense basemap: what a real basemap shows from zoom ~4 to 14. Metres from the
 * centre out to ±30 km (the metro area) and ±150 km (the region); degrees beyond that (cities, states, countries).
 * Its own random stream, so the core stays exactly what it was.
 */
function syntheticRegion(center: [number, number], d: Draw, L: Record<string, Feature[]>) {
  const { f, at, line } = d;
  const rand = mulberry32(24);
  const pick = <T,>(a: readonly T[]) => a[Math.floor(rand() * a.length)];
  const HEAD = ['Ash', 'Bram', 'Cal', 'Dun', 'Elm', 'Fen', 'Gar', 'Hol', 'Iver', 'Kel', 'Lang', 'Mar', 'Nor', 'Oak', 'Pen', 'Quar', 'Ros', 'Sel', 'Thorn', 'Ul', 'Ver', 'Wick', 'Yar', 'Brook', 'Cop', 'Dray', 'Est', 'Fair', 'Glen', 'Hart'] as const;
  const TAIL = ['ford', 'by', 'ton', 'ham', 'field', 'wick', 'stead', 'bury', 'mere', 'dale', 'well', 'cross', 'gate', 'hurst', 'ley', 'moor', 'side', 'worth', 'combe', 'haven'] as const;
  const name = () => `${rand() < 0.15 ? pick(['North ', 'South ', 'East ', 'West ', 'Upper ', 'Lower ', 'Old ', 'New '] as const) : ''}${pick(HEAD)}${pick(TAIL)}`;
  const named = (n: string) => ({ name: n, 'name:latin': n });
  const pt = (x: number, y: number): Feature['geometry'] => ({ type: 'Point', coordinates: at(x, y) });
  const blob = (cx: number, cy: number, r: number, k: number, jitter: number): Feature['geometry'] => {
    const pts = Array.from({ length: k }, (_, i) => {
      const a = (i / k) * 2 * Math.PI, rr = r * (1 - jitter / 2 + jitter * rand());
      return at(cx + rr * Math.cos(a), cy + rr * Math.sin(a));
    });
    return { type: 'Polygon', coordinates: [[...pts, pts[0]]] };
  };
  const nearCore = (x: number, y: number, m = 1500) => Math.abs(x) < m && Math.abs(y) < m;
  /** A polyline in `transportation`, one feature per `every` vertices (a way per stretch, as mapped), merged in `transportation_name`. */
  const road = (pts: [number, number][], props: Record<string, unknown>, nm?: string, ref?: string, every = 2) => {
    for (let i = 0; i < pts.length - 1; i += every) L.transportation.push(f(line(...pts.slice(i, i + every + 1)), { oneway: 0, ...props }));
    if (nm || ref) L.transportation_name.push(f(line(...pts), { class: props.class, ...(nm ? named(nm) : {}), ...(ref ? { ref, ref_length: ref.length, network: 'road' } : {}) }));
  };
  const along = (a: [number, number], b: [number, number], step: number): [number, number][] => {
    const n = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    return Array.from({ length: n + 1 }, (_, i) => [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]);
  };

  // --- arterials: a 1.2 km grid from ±3.6 km to ±24 km, one feature per 2.4 km; primaries and some secondaries carry route refs
  for (let k = -20; k <= 20; k++) {
    if (Math.abs(k) < 3) continue;
    const c = k * 1200;
    const cls = k % 4 === 0 ? 'primary' : k % 2 === 0 ? 'secondary' : 'tertiary';
    const ref = cls === 'primary' ? `${120 + k}` : cls === 'secondary' && k % 3 === 0 ? `B${220 + k}` : undefined;
    road(along([c, -24000], [c, 24000], 1200), { class: cls }, `${name()} Avenue`, ref);
    road(along([-24000, c], [24000, c], 1200), { class: cls }, `${name()} Road`, ref && `${ref}A`);
  }
  // --- the core's own main roads carry refs too, and bus stops line its secondary roads
  for (const t of L.transportation_name) {
    const ref = ({ 'Meridian Road': 'A1', 'Parallel Road': 'A2', 'Ring Motorway': 'M10' } as Record<string, string>)[t.properties!.name];
    if (ref) Object.assign(t.properties!, { ref, ref_length: ref.length, network: 'road' });
  }
  for (const i of [-10, -5, 5, 10]) {
    for (let j = -9; j <= 9; j += 2) {
      const st = (k: number) => `${Math.abs(k)} ${k < 0 ? 'W' : 'E'} St`, av = (k: number) => `${Math.abs(k)} ${k < 0 ? 'S' : 'N'} Av`;
      L.poi.push(f(pt(i * 120 + 8, j * 120 + 60), { class: 'bus', subclass: 'bus_stop', ...named(`${st(i)} / ${av(j)}`), rank: 30 }));
      L.poi.push(f(pt(j * 120 + 60, i * 120 + 8), { class: 'bus', subclass: 'bus_stop', ...named(`${av(i)} / ${st(j)}`), rank: 30 }));
    }
  }

  // --- motorways: an orbital at 9 km and six radials out to 150 km; trunk roads between them
  const orbital: [number, number][] = Array.from({ length: 49 }, (_, i) => [9000 * Math.cos((i / 48) * 2 * Math.PI), 9000 * Math.sin((i / 48) * 2 * Math.PI)]);
  road(orbital, { class: 'motorway' }, 'Orbital Motorway', 'M9', 3);
  for (let r = 0; r < 6; r++) {
    const a = ((15 + 60 * r) * Math.PI) / 180;
    const pts = Array.from({ length: 48 }, (_, i): [number, number] => {
      const dist = 9000 + i * 3000, bend = Math.sin(i / 5) * 1500;
      return [dist * Math.cos(a) - bend * Math.sin(a), dist * Math.sin(a) + bend * Math.cos(a)];
    });
    road(pts, { class: 'motorway' }, `${name()} Motorway`, `M${r + 1}`);
  }
  for (let r = 0; r < 6; r++) {
    const a = ((45 + 60 * r) * Math.PI) / 180;
    road(along([3000 * Math.cos(a), 3000 * Math.sin(a)], [60000 * Math.cos(a), 60000 * Math.sin(a)], 2000), { class: 'trunk' }, `${name()} Way`, `A${11 + r * 7}`);
  }

  // --- rail: three lines across the metro area, a station every ~2.5 km; stations on the core's own line too
  const station = (x: number, y: number) => L.poi.push(f(pt(x, y), { class: 'railway', subclass: 'station', ...named(`${name()} Station`), rank: 1 + Math.floor(rand() * 5) }));
  for (const [a, b] of [[[-40000, 3000], [40000, 9000]], [[-5000, -40000], [8000, 40000]], [[-40000, -20000], [30000, 25000]]] as [number, number][][]) {
    const pts = along(a, b, 2500);
    road(pts, { class: 'rail' }, undefined, undefined, 4);
    for (const [x, y] of pts.slice(1, -1)) if (!nearCore(x, y, 1300)) station(x + 20, y + 20);
  }
  for (const x of [-2400, -1200, 1200]) station(x, 1520);

  // --- places: the metro area on a jittered 3.6 km grid (suburbs, neighbourhoods, quarters; villages further out), towns in a ring
  for (let gx = -8; gx <= 8; gx++) {
    for (let gy = -8; gy <= 8; gy++) {
      const x = gx * 3600 + (rand() - 0.5) * 2400, y = gy * 3600 + (rand() - 0.5) * 2400;
      if (nearCore(x, y)) continue;
      const cls = Math.hypot(x, y) > 12000 && rand() < 0.4 ? 'village' : pick(['suburb', 'suburb', 'neighbourhood', 'neighbourhood', 'quarter'] as const);
      L.place.push(f(pt(x, y), { class: cls, ...named(name()), rank: cls === 'village' ? 14 : 12 + Math.floor(rand() * 8) }));
    }
  }
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * 2 * Math.PI + rand() * 0.3, r = 14000 + rand() * 16000;
    L.place.push(f(pt(r * Math.cos(a), r * Math.sin(a)), { class: 'town', ...named(name()), rank: 9 + Math.floor(rand() * 3) }));
  }
  for (let i = 0; i < 24; i++) {
    const a = rand() * 2 * Math.PI, r = 35000 + rand() * 110000;
    L.place.push(f(pt(r * Math.cos(a), r * Math.sin(a)), { class: rand() < 0.3 ? 'city' : 'town', ...named(name()), rank: 5 + Math.floor(rand() * 5) }));
  }

  // --- water: a river across the metro area (a line in `waterway`, a strip in `water`), streams, a canal, lakes
  const river: [number, number][] = Array.from({ length: 81 }, (_, i) => {
    const x = -40000 + i * 1000;
    return [x, -6000 + 1500 * Math.sin(x / 7000) + 600 * Math.sin(x / 2300)];
  });
  const riverName = `River ${pick(HEAD)}water`;
  for (let i = 0; i < river.length - 1; i += 4) L.waterway.push(f(line(...river.slice(i, i + 5)), { class: 'river', ...named(riverName) }));
  L.water.push(f({ type: 'Polygon', coordinates: [[...river.map(([x, y]) => at(x, y + 70)), ...[...river].reverse().map(([x, y]) => at(x, y - 70)), at(river[0][0], river[0][1] + 70)]] }, { class: 'river' }));
  for (let i = 0; i < 22; i++) {
    const x = (rand() - 0.5) * 50000, y = (rand() - 0.5) * 50000, a = rand() * 2 * Math.PI, len = 1500 + rand() * 3000;
    if (nearCore(x, y, 3000)) continue;
    const pts = Array.from({ length: 6 }, (_, j): [number, number] => [x + (Math.cos(a) * len * j) / 5 + (rand() - 0.5) * 200, y + (Math.sin(a) * len * j) / 5 + (rand() - 0.5) * 200]);
    L.waterway.push(f(line(...pts), { class: 'stream', ...named(`${pick(HEAD)} ${pick(['Brook', 'Creek', 'Run', 'Beck'] as const)}`) }));
  }
  L.waterway.push(f(line([-30000, 12000], [-12000, 14000], [4000, 13000], [26000, 16000]), { class: 'canal', ...named(`${pick(HEAD)} Canal`) }));
  for (let i = 0; i < 16; i++) {
    const x = (rand() - 0.5) * 56000, y = (rand() - 0.5) * 56000, r = 250 + rand() * 900;
    if (nearCore(x, y, 3500)) continue;
    L.water.push(f(blob(x, y, r, 10, 0.5), { class: 'lake' }));
    L.water_name.push(f(pt(x, y), { class: 'lake', ...named(`${pick(['Lake ', ''] as const)}${pick(HEAD)}${pick([' Pond', ' Reservoir', ' Water', 'mere'] as const)}`) }));
  }

  // --- green: named parks, woods and farmland, other land use
  for (let i = 0; i < 30; i++) {
    const x = (rand() - 0.5) * 50000, y = (rand() - 0.5) * 50000, w = 300 + rand() * 1400, h = 300 + rand() * 1400;
    if (nearCore(x, y, 2800)) continue;
    L.park.push(f(d.box(x, y, x + w, y + h), { class: pick(['public_park', 'nature_reserve'] as const), ...named(`${pick(HEAD)}${pick(TAIL)} ${pick(['Park', 'Common', 'Woods', 'Gardens', 'Fields'] as const)}`) }));
  }
  for (let i = 0; i < 40; i++) {
    const x = (rand() - 0.5) * 60000, y = (rand() - 0.5) * 60000;
    if (nearCore(x, y, 3000)) continue;
    L.landcover.push(f(blob(x, y, 400 + rand() * 1500, 8, 0.6), { class: pick(['wood', 'farmland', 'grass', 'wetland'] as const) }));
  }
  for (let i = 0; i < 20; i++) {
    const x = (rand() - 0.5) * 40000, y = (rand() - 0.5) * 40000, w = 400 + rand() * 1200, h = 400 + rand() * 1200;
    if (nearCore(x, y, 3000)) continue;
    L.landuse.push(f(d.box(x, y, x + w, y + h), { class: pick(['commercial', 'industrial', 'residential', 'cemetery', 'school'] as const) }));
  }

  // --- POIs out in the metro area: a ranked POI every ~300 m out to ±5 km
  for (let gx = -16; gx <= 16; gx++) {
    for (let gy = -16; gy <= 16; gy++) {
      const x = gx * 300 + (rand() - 0.5) * 200, y = gy * 300 + (rand() - 0.5) * 200, cls = pick(POI_CLASSES);
      if (nearCore(x, y, 1300)) continue;
      L.poi.push(f(pt(x, y), { class: cls, subclass: cls, ...named(`${pick(HEAD)}${pick(TAIL)} ${cls[0].toUpperCase()}${cls.slice(1)}`), rank: 1 + Math.floor(rand() * 30) }));
    }
  }

  // --- airports: the area, two runways, a label with its IATA code
  for (const [x, y, iata, kind] of [[15000, 8000, 'WRV', 'International'], [-18000, -13000, 'GWT', 'Regional']] as const) {
    L.aeroway.push(f(blob(x, y, 1800, 12, 0.2), { class: 'aerodrome' }));
    L.aeroway.push(f(line([x - 1400, y - 300], [x + 1400, y + 300]), { class: 'runway', ref: '09/27' }), f(line([x - 400, y - 1200], [x + 200, y + 1200]), { class: 'runway', ref: '18/36' }));
    L.aerodrome_label.push(f(pt(x, y + 200), { class: kind === 'International' ? 'international' : 'regional', ...named(`${name()} ${kind} Airport`), iata, icao: `K${iata}`, ele: 12, ele_ft: 39 }));
  }

  // --- beyond the region, in degrees: cities, states and countries with their boundaries, a sea
  const lat = (dy: number) => Math.max(-80, Math.min(80, center[1] + dy));
  const P = (dx: number, dy: number, props: Record<string, unknown>) => L.place.push(f({ type: 'Point', coordinates: [((center[0] + dx + 540) % 360) - 180, lat(dy)] }, props));
  for (let i = 0; i < 30; i++) P((rand() - 0.5) * 30, (rand() - 0.5) * 18, { class: 'city', ...named(name()), rank: 2 + Math.floor(rand() * 5), ...(i === 0 ? { capital: 2 } : {}) });
  for (let i = 0; i < 10; i++) P((rand() - 0.5) * 24, (rand() - 0.5) * 14, { class: 'state', ...named(`${pick(HEAD)}${pick(['shire', 'land', 'mark', 'ia'] as const)}`), rank: 3 });
  ([[4, -3, 'Republic of Wrightland', 1], [-14, 6, 'Fixturia', 2], [13, 8, 'Harnessa', 3], [-6, -12, 'Probestan', 3]] as const).forEach(([dx, dy, n, rank]) => P(dx, dy, { class: 'country', ...named(n), rank, iso_a2: 'XX' }));
  // lines and the sea are left out where they would cross the antimeridian (an app centred near ±180°)
  const inWorld = (c: number[][]) => c.every(([x]) => x > -180 && x < 180);
  for (const [pts, admin_level] of [[[[-9, -20], [-8, 0], [-10, 20]], 2], [[[-20, -5], [0, -7], [20, -6]], 2], [[[0.6, -8], [0.5, 8]], 4], [[[-8, 0.4], [8, 0.3]], 4]] as [number[][], number][]) {
    const c = pts.map(([dx, dy]) => [center[0] + dx, lat(dy)]);
    if (inWorld(c)) L.boundary.push(f({ type: 'LineString', coordinates: c }, { admin_level, disputed: 0, maritime: 0 }));
  }
  const sea = [[18, -10], [26, -10], [26, 10], [18, 10], [18, -10]].map(([dx, dy]) => [center[0] + dx, lat(dy)]);
  if (inWorld(sea)) {
    L.water.push(f({ type: 'Polygon', coordinates: [sea] }, { class: 'ocean' }));
    L.water_name.push(f({ type: 'Point', coordinates: [center[0] + 22, center[1]] }, { class: 'sea', ...named('Synthetic Sea') }));
  }
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
  if (dense) return denseStyle({ src, cls, font, poi, label });
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
function denseStyle(h: { src: (l: string) => any; cls: (...c: string[]) => any; font: string[]; poi: (id: string, maxRank: number, minzoom: number) => any; label: (id: string, c: string, size: number) => any }) {
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
  const roads = (['minor', 'tertiary', 'secondary', 'primary', 'trunk', 'motorway'] as const).flatMap((c, i) => [
    { id: `highway-${c}-casing`, type: 'line', ...src('transportation'), filter: cls(c), layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#c9c2b8', 'line-width': ['interpolate', ['exponential', 1.4], ['zoom'], 8, 0.5 + i / 2, 18, 14 + 4 * i] } },
    { id: `highway-${c}`, type: 'line', ...src('transportation'), filter: cls(c), layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['#ffffff', '#fffbe8', '#fdf6c9', '#fdf0b5', '#f9d58f', '#f6b26b'][i], 'line-width': ['interpolate', ['exponential', 1.4], ['zoom'], 8, 0.3 + i / 2, 18, 11 + 4 * i] } },
  ]);
  const notTransit = ['!', ['match', ['get', 'subclass'], ['station', 'bus_stop'], true, false]];
  const poiTier = (id: string, lo: number, hi: number, minzoom: number) => ({ ...h.poi(id, hi, minzoom), filter: ['all', ['>', ['get', 'rank'], lo], ['<=', ['get', 'rank'], hi], notTransit] });
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
    ...roads,
    { id: 'highway-path', type: 'line', ...src('transportation'), filter: cls('path', 'track'), paint: { 'line-color': '#cba', 'line-dasharray': [1, 1] } },
    byId('railway'),
    { id: 'railway-hatching', type: 'line', ...src('transportation'), filter: cls('rail'), paint: { 'line-color': '#9a9a9a', 'line-width': 5, 'line-dasharray': [0.2, 4] } },
    ...variants.filter((l) => l.id.startsWith('bridge')),
    { id: 'boundary-3', type: 'line', ...src('boundary'), filter: ['>=', ['get', 'admin_level'], 3], paint: { 'line-color': '#9e9cab', 'line-dasharray': [4, 2] } },
    { id: 'boundary-2', type: 'line', ...src('boundary'), filter: ['==', ['get', 'admin_level'], 2], paint: { 'line-color': '#8d8b9d', 'line-width': 1.5 } },
    // ---- labels: everything below is a symbol layer, as in a production style ----
    byId('road_oneway'),
    { ...byId('road_oneway'), id: 'road_oneway_opposite', filter: ['==', ['get', 'oneway'], -1], layout: { ...byId('road_oneway').layout, 'icon-rotate': 180 } },
    text('housenumber', 'housenumber', ['get', 'housenumber'], 10, 15),
    { ...byId('water_name_point_label'), filter: ['==', ['geometry-type'], 'Point'] },
    text('waterway-name', 'waterway', ['get', 'name'], 11, 11, { layout: { 'symbol-placement': 'line' } }),
    text('park-name', 'park', ['get', 'name'], 12, 12),
    poiTier('poi_r20', 14, 30, 15), poiTier('poi_r7', 6, 14, 15), poiTier('poi_r1', 0, 6, 14),
    {
      id: 'poi_transit', type: 'symbol', ...src('poi'), minzoom: 13, filter: ['match', ['get', 'subclass'], ['station', 'bus_stop'], true, false],
      layout: { 'icon-image': ['match', ['get', 'class'], 'railway', 'railway', 'bus'], 'text-field': ['get', 'name'], 'text-font': font, 'text-size': 10, 'text-anchor': 'left', 'text-offset': [0.9, 0], 'text-optional': true },
      paint: { 'text-color': '#2e5a88', 'text-halo-color': '#ffffff', 'text-halo-width': 1 },
    },
    { ...byId('highway-name-minor'), minzoom: 14 },
    { ...byId('highway-name-major'), filter: cls('primary', 'secondary', 'tertiary', 'trunk') },
    {
      id: 'highway-shield', type: 'symbol', ...src('transportation_name'), minzoom: 8, filter: ['all', ['has', 'ref'], ['<=', ['get', 'ref_length'], 6]],
      layout: { 'symbol-placement': 'line', 'symbol-spacing': 300, 'icon-image': ['concat', 'shield-', ['get', 'ref_length']], 'icon-rotation-alignment': 'viewport', 'text-rotation-alignment': 'viewport', 'text-field': ['get', 'ref'], 'text-font': font, 'text-size': 10 },
      paint: { 'text-color': '#303048' },
    },
    {
      id: 'airport-label', type: 'symbol', ...src('aerodrome_label'), minzoom: 10, filter: ['has', 'iata'],
      layout: { 'icon-image': 'airport', 'text-field': ['get', 'name'], 'text-font': font, 'text-size': 11, 'text-anchor': 'top', 'text-offset': [0, 0.9], 'text-optional': true },
      paint: { 'text-color': '#5a4a7a', 'text-halo-color': '#ffffff', 'text-halo-width': 1 },
    },
    h.label('label_neighbourhood', 'neighbourhood', 11), h.label('label_quarter', 'quarter', 11), h.label('label_suburb', 'suburb', 12), h.label('label_village', 'village', 12),
    byId('label_town'), byId('label_city'),
    { ...h.label('label_state', 'state', 13), maxzoom: 9 },
    ...([['label_country_3', 13], ['label_country_2', 15], ['label_country_1', 17]] as const).map(([id, size], i) => ({ ...h.label(id, 'country', size), maxzoom: 9, filter: ['all', cls('country'), i === 0 ? ['>=', ['get', 'rank'], 3] : ['==', ['get', 'rank'], 2 - i + 1]] })),
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
