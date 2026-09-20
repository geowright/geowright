#!/usr/bin/env node
// OPT-IN realism: caches a SMALL extract of a real basemap (OpenFreeMap "bright": OpenStreetMap data, ODbL;
// OpenMapTiles schema; OSM Bright-derived style) OUTSIDE the repository, for the opt-in spec set
//   GEOWRIGHT_REAL_BASEMAP=1 npx playwright test tests/wild/real-basemap.spec.ts
//
// NEVER committed (the repo is permissive-licenses-only), NEVER run in CI, never fetched by a test: the specs read
// the cache and skip when it is missing. ~60 small requests, once. Be polite: do not loop this.
//
//   node scripts/fetch-real-basemap.mjs [--center lng,lat] [--radius-km 1.5] [--dir ~/.cache/geowright/openfreemap]
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const [lng, lat] = arg('center', '-74.0066,40.7135').split(',').map(Number); // where MapLibre's 3D-buildings example looks
const radiusKm = Number(arg('radius-km', '1.5'));
const dir = arg('dir', join(homedir(), '.cache/geowright/openfreemap')).replace(/^~/, homedir());
const ORIGIN = 'https://tiles.openfreemap.org';

let requests = 0;
async function get(url, as = 'buffer') {
  requests++;
  const res = await fetch(url, { headers: { 'user-agent': 'geowright-test-fixture-cache (one-off, opt-in)' } });
  if (res.status === 204 || res.status === 404) return null; // an empty tile is a fact, not an error
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return as === 'json' ? res.json() : Buffer.from(await res.arrayBuffer());
}
async function save(rel, body) {
  const file = join(dir, rel);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, typeof body === 'string' ? body : body);
}

const style = await get(`${ORIGIN}/styles/bright`, 'json');
await save('style.json', JSON.stringify(style));
const tilejson = await get(style.sources.openmaptiles.url, 'json');
await save('planet.json', JSON.stringify(tilejson));
const template = tilejson.tiles[0];

const tileOf = (lo, la, z) => {
  const n = 2 ** z;
  const x = Math.floor(((lo + 180) / 360) * n);
  const r = (la * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  return [Math.min(n - 1, Math.max(0, x)), Math.min(n - 1, Math.max(0, y))];
};
const dLat = radiusKm / 111.32, dLng = radiusKm / (111.32 * Math.cos((lat * Math.PI) / 180));
let tiles = 0, bytes = 0;
for (let z = 0; z <= Math.min(14, tilejson.maxzoom ?? 14); z++) {
  const [x0, y1] = tileOf(lng - dLng, lat - dLat, z);
  const [x1, y0] = tileOf(lng + dLng, lat + dLat, z);
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      const body = await get(template.replace('{z}', z).replace('{x}', x).replace('{y}', y));
      if (!body) continue;
      await save(`tiles/${z}/${x}/${y}.pbf`, body);
      tiles++;
      bytes += body.length;
    }
  }
}

for (const suffix of ['.json', '.png', '@2x.json', '@2x.png']) {
  const body = await get(`${style.sprite}${suffix}`);
  if (body) await save(`sprite${suffix}`, body);
}
const fonts = new Set();
JSON.stringify(style.layers, (k, v) => (k === 'text-font' && Array.isArray(v) ? (v.filter((f) => typeof f === 'string').forEach((f) => fonts.add(f)), v) : v));
for (const font of fonts) {
  for (const range of ['0-255', '256-511']) {
    const body = await get(style.glyphs.replace('{fontstack}', encodeURIComponent(font)).replace('{range}', range));
    if (body) await save(`fonts/${font}/${range}.pbf`, body);
  }
}

await save('SOURCE.md', `# Cached basemap extract — NOT part of the geowright repository

Fetched ${new Date().toISOString().slice(0, 10)} from ${ORIGIN} by scripts/fetch-real-basemap.mjs, around ${lng},${lat} (±${radiusKm} km), zoom 0–14.

- Map data © OpenStreetMap contributors, Open Database License (ODbL) 1.0 — https://www.openstreetmap.org/copyright
- Vector tile schema: OpenMapTiles (CC-BY 4.0) — https://openmaptiles.org
- Style "bright" and tile hosting: OpenFreeMap — https://openfreemap.org
- Fonts: see the style's glyph source.

A local test cache. Do not commit it, do not redistribute it.
`);
await save('meta.json', JSON.stringify({ center: [lng, lat], radiusKm, tileTemplate: template, tiles, layers: style.layers.length }));
console.log(`${dir}: style with ${style.layers.length} layers, ${tiles} tiles (${(bytes / 1024).toFixed(0)} KB), ${fonts.size} fonts, ${requests} requests`);
