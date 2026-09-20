import 'maplibre-gl/dist/maplibre-gl.css';
import { Map, setWorkerUrl, type StyleSpecification } from 'maplibre-gl';

setWorkerUrl('/maplibre/maplibre-gl-worker.mjs');

const style = (color: string, sites: [number, string, number, number][]): StyleSpecification => ({
  version: 8,
  sources: {
    sites: {
      type: 'geojson',
      promoteId: 'id',
      data: {
        type: 'FeatureCollection',
        features: sites.map(([id, name, lng, lat]) => ({ type: 'Feature', properties: { id, name }, geometry: { type: 'Point', coordinates: [lng, lat] } })),
      },
    },
  },
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#eef1f4' } },
    { id: 'sites', type: 'circle', source: 'sites', paint: { 'circle-radius': 9, 'circle-color': color, 'circle-stroke-width': 2, 'circle-stroke-color': '#fff' } },
  ],
});

// Same layer name and the same feature id on both maps, on purpose: the mapId must disambiguate.
const maps = {
  left: new Map({ container: 'left', center: [34.78, 32.08], zoom: 11, attributionControl: false, style: style('#d32f2f', [[1, 'Left depot', 34.78, 32.08], [2, 'Left yard', 34.8, 32.1]]) }),
  right: new Map({ container: 'right', center: [35.0, 31.8], zoom: 11, attributionControl: false, style: style('#1976d2', [[1, 'Right depot', 35.0, 31.8]]) }),
};
const out = document.querySelector('[data-testid="last-click"]') as HTMLElement;
for (const [name, map] of Object.entries(maps)) {
  ((window as any).__geowright_maps ??= {})[name] = map;
  map.on('click', 'sites', (e) => {
    out.textContent = `${name}:${(e.features![0].properties as any).name}`;
  });
}
