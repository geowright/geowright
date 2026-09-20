import 'maplibre-gl/dist/maplibre-gl.css';
import { Map, setWorkerUrl } from 'maplibre-gl';
import { DENSE_CENTER, denseAssets, denseLots } from './dense-data';

setWorkerUrl('/maplibre/maplibre-gl-worker.mjs');

// Dense-map stress page: ~5,000 points + ~1,000 overlapping polygons, no clustering on purpose.
const map = new Map({
  container: 'map',
  center: DENSE_CENTER,
  zoom: 12,
  attributionControl: false,
  style: {
    version: 8,
    sources: {
      lots: { type: 'geojson', promoteId: 'id', data: denseLots() as unknown as GeoJSON.GeoJSON },
      assets: { type: 'geojson', promoteId: 'id', data: denseAssets() as unknown as GeoJSON.GeoJSON },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#eef1f4' } },
      {
        id: 'lots',
        type: 'fill',
        source: 'lots',
        paint: { 'fill-color': ['match', ['get', 'use'], 'housing', '#9ccc65', 'retail', '#4fc3f7', 'depot', '#ffb74d', '#cfd8dc'], 'fill-opacity': 0.55 },
      },
      { id: 'lots-outline', type: 'line', source: 'lots', paint: { 'line-color': '#455a64', 'line-width': 1 } },
      {
        id: 'assets',
        type: 'circle',
        source: 'assets',
        paint: {
          'circle-radius': 5,
          'circle-color': ['match', ['get', 'status'], 'fault', '#c62828', 'warn', '#f9a825', '#1565c0'],
          'circle-stroke-width': 1,
          'circle-stroke-color': '#ffffff',
        },
      },
    ],
  },
});

((window as any).__geowright_maps ??= {}).main = map;

// What the app says was clicked (topmost asset wins over a lot) — the ground truth for click tests.
const out = document.querySelector('[data-testid="selected"]') as HTMLElement;
map.on('click', (e) => {
  const hits = map.queryRenderedFeatures(e.point, { layers: ['assets', 'lots'] });
  const f = hits.find((h) => h.layer.id === 'assets') ?? hits[0];
  out.textContent = f ? `${f.layer.id}:${(f.properties as any).id}` : '';
});
