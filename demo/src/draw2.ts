import 'maplibre-gl/dist/maplibre-gl.css';
import '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css';
import { Map, setWorkerUrl } from 'maplibre-gl';
import MapboxDraw from '@mapbox/mapbox-gl-draw';

setWorkerUrl('/maplibre/maplibre-gl-worker.mjs');

// A SECOND draw library, to prove the gesture helpers are not terra-draw-shaped: mapbox-gl-draw
// finishes a shape on double-click (or Enter), terra-draw on a click of the first/last vertex.
const map = new Map({
  container: 'map',
  center: [34.78, 32.08],
  zoom: 12,
  attributionControl: false,
  style: { version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#eef1f4' } }] },
});
((window as any).__geowright_maps ??= {}).main = map;

const draw = new MapboxDraw({ displayControlsDefault: false });
// mapbox-gl-draw is written against mapbox-gl's IControl; MapLibre's is structurally the same.
map.addControl(draw as any);

const count = document.querySelector('[data-testid="draw-count"]') as HTMLElement;
const refresh = () => (count.textContent = String(draw.getAll().features.length));
for (const ev of ['draw.create', 'draw.delete', 'draw.update']) map.on(ev as any, refresh);

const modes: Record<string, string> = { 'draw-polygon': 'draw_polygon', 'draw-line': 'draw_line_string', 'draw-select': 'simple_select' };
for (const [testId, mode] of Object.entries(modes)) {
  (document.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement).addEventListener('click', () => draw.changeMode(mode as any));
}
