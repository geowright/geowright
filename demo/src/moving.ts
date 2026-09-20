import 'maplibre-gl/dist/maplibre-gl.css';
import { Map, setWorkerUrl, type GeoJSONSource } from 'maplibre-gl';

setWorkerUrl('/maplibre/maplibre-gl-worker.mjs');

// Things that never stop moving: two patrol vehicles driving round a block (features WITH ids and properties,
// unlike MapLibre's own "animate a point"), and a parked one next to their route. The map never idles.
const map = new Map({
  container: 'map',
  center: [34.8, 32.08],
  zoom: 12,
  attributionControl: false,
  style: {
    version: 8,
    sources: {
      patrols: { type: 'geojson', promoteId: 'id', data: { type: 'FeatureCollection', features: [] } },
      parked: { type: 'geojson', promoteId: 'id', data: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { id: 9, unit: 'P-9' }, geometry: { type: 'Point', coordinates: [34.8, 32.08] } }] } },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#eef1f4' } },
      { id: 'parked', type: 'circle', source: 'parked', paint: { 'circle-radius': 9, 'circle-color': '#616161' } },
      { id: 'patrols', type: 'circle', source: 'patrols', paint: { 'circle-radius': 9, 'circle-color': ['match', ['get', 'unit'], 'P-1', '#d32f2f', '#1976d2'], 'circle-stroke-width': 2, 'circle-stroke-color': '#fff' } },
    ],
  },
});
((window as any).__geowright_maps ??= {}).main = map;

const el = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement;
let clicks = 0;
map.on('click', (e) => {
  el('click-count').textContent = String(++clicks);
  const f = map.queryRenderedFeatures(e.point, { layers: ['patrols', 'parked'] })[0];
  el('clicked').textContent = f ? String(f.properties.unit) : 'nothing';
});
map.on('mousemove', (e) => {
  const f = map.queryRenderedFeatures(e.point, { layers: ['patrols', 'parked'] })[0];
  el('hovered').textContent = f ? String(f.properties.unit) : '';
});

map.on('load', () => {
  const centre = map.project([34.8, 32.08]);
  const R = 140; // px: the route is a circle of this radius round the parked unit
  let angle = 0;
  let last = performance.now();
  const tick = (now: number) => {
    const speed = Number((el('speed') as HTMLInputElement).value) || 0; // px per second along the route
    angle += ((now - last) / 1000) * (speed / R);
    last = now;
    const at = (a: number) => map.unproject([centre.x + R * Math.cos(a), centre.y + R * Math.sin(a)]).toArray();
    (map.getSource('patrols') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: { id: 1, unit: 'P-1' }, geometry: { type: 'Point', coordinates: at(angle) } },
        { type: 'Feature', properties: { id: 2, unit: 'P-2' }, geometry: { type: 'Point', coordinates: at(angle + Math.PI) } },
      ],
    });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
