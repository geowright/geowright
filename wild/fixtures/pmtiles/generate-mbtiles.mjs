// First-party synthetic vector data for protomaps/PMTiles' MapLibre example.
// From the repository root, with Node 26 (node:sqlite) and installed dependencies:
//   node wild/fixtures/pmtiles/generate-mbtiles.mjs
//   pmtiles convert .scratch/pmtiles-synthetic.mbtiles wild/fixtures/pmtiles/synthetic-firenze.pmtiles
//   pmtiles verify wild/fixtures/pmtiles/synthetic-firenze.pmtiles
// The shipped archive was converted with Homebrew pmtiles 1.31.2 (BSD-3-Clause).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { GeoJSONVT } from '@maplibre/geojson-vt';
import { fromGeojsonVt } from '@maplibre/vt-pbf';

const center = [11.2543435, 43.7672134];
const point = (id, dx, dy, name) => ({ type: 'Feature', id, properties: { name }, geometry: { type: 'Point', coordinates: [center[0] + dx, center[1] + dy] } });
const line = (id, coordinates, name) => ({ type: 'Feature', id, properties: { name }, geometry: { type: 'LineString', coordinates: coordinates.map(([dx,dy]) => [center[0]+dx,center[1]+dy]) } });
const polygon = (id, x0, y0, x1, y1, name) => ({ type: 'Feature', id, properties: { name }, geometry: { type: 'Polygon', coordinates: [[[x0,y0],[x1,y0],[x1,y1],[x0,y1],[x0,y0]].map(([dx,dy]) => [center[0]+dx,center[1]+dy])] } });
const features = {
  water: [polygon(1, .010, -.012, .019, -.005, 'Blue Pond')],
  buildings: [polygon(10, -.004, -.003, -.002, -.001, 'Mercato Hall'), polygon(11, .003, .001, .005, .003, 'Bell Tower')],
  roads: [line(20, [[-.030,0],[.030,0]], 'Main Street'), line(21, [[0,-.030],[0,.030]], 'Cross Road')],
  pois: [point(30, -.003, -.002, 'Market'), point(31, .004, .002, 'Tower')],
};
const indexes = Object.entries(features).map(([name, fs]) => [name, new GeoJSONVT({type:'FeatureCollection',features:fs}, {maxZoom:14,indexMaxZoom:5,buffer:64})]);
const z = 13, n = 2 ** z;
const cx = Math.floor((center[0] + 180) / 360 * n);
const lat = center[1] * Math.PI / 180;
const cy = Math.floor((1 - Math.asinh(Math.tan(lat)) / Math.PI) / 2 * n);
mkdirSync('.scratch', { recursive: true });
const db = new DatabaseSync('.scratch/pmtiles-synthetic.mbtiles');
db.exec('DROP TABLE IF EXISTS metadata; DROP TABLE IF EXISTS tiles; CREATE TABLE metadata (name TEXT, value TEXT); CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB); CREATE UNIQUE INDEX tile_index ON tiles (zoom_level, tile_column, tile_row);');
const meta = db.prepare('INSERT INTO metadata VALUES (?, ?)');
for (const [k,v] of Object.entries({name:'Geowright synthetic Firenze',type:'baselayer',version:'1',format:'pbf',minzoom:'13',maxzoom:'13',bounds:'11.20,43.72,11.31,43.81',center:`${center[0]},${center[1]},13`,json:JSON.stringify({vector_layers:Object.keys(features).map(id=>({id,fields:{name:'String'},minzoom:13,maxzoom:13}))})})) meta.run(k,v);
const insert = db.prepare('INSERT INTO tiles VALUES (?, ?, ?, ?)');
let count=0;
for (let x=cx-2;x<=cx+2;x++) for(let y=cy-2;y<=cy+2;y++) {
  const tiles={};
  for(const [name,index] of indexes) { const t=index.getTile(z,x,y); if(t) tiles[name]=t; }
  if(!Object.keys(tiles).length) continue;
  insert.run(z,x,n-1-y,Buffer.from(fromGeojsonVt(tiles,{version:2,extent:4096})));
  count++;
}
db.close();
console.log({center,cx,cy,count});
