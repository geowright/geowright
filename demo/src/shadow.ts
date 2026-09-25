import css from 'maplibre-gl/dist/maplibre-gl.css?inline';
import { Map, setWorkerUrl } from 'maplibre-gl';

setWorkerUrl('/maplibre/maplibre-gl-worker.mjs');

/** A web component that keeps its map in an OPEN shadow root: the page's DOM sees only <geo-map>. */
class GeoMap extends HTMLElement {
  connectedCallback() {
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${css} .map { width: 640px; height: 420px; border: 1px solid #999; }</style><div class="map"></div>`;
    const map = new Map({
      container: root.querySelector('.map') as HTMLElement,
      center: [34.78, 32.08],
      zoom: 11,
      attributionControl: false,
      style: {
        version: 8,
        sources: {
          sites: {
            type: 'geojson',
            promoteId: 'id',
            data: {
              type: 'FeatureCollection',
              features: [
                { type: 'Feature', properties: { id: 1, name: 'Depot' }, geometry: { type: 'Point', coordinates: [34.78, 32.08] } },
                { type: 'Feature', properties: { id: 2, name: 'Yard' }, geometry: { type: 'Point', coordinates: [34.8, 32.1] } },
              ],
            },
          },
        },
        layers: [
          { id: 'background', type: 'background', paint: { 'background-color': '#eef1f4' } },
          { id: 'sites', type: 'circle', source: 'sites', paint: { 'circle-radius': 9, 'circle-color': '#d32f2f', 'circle-stroke-width': 2, 'circle-stroke-color': '#fff' } },
        ],
      },
    });
    ((window as any).__geowright_maps ??= {}).main = map;
    const out = document.querySelector('[data-testid="last-click"]') as HTMLElement;
    map.on('click', 'sites', (e) => {
      out.textContent = String((e.features![0].properties as any).name);
    });
  }
}
customElements.define('geo-map', GeoMap);
