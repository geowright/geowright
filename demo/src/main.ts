import 'maplibre-gl/dist/maplibre-gl.css';
import {
  Map as MlMap,
  Marker,
  Popup,
  setWorkerUrl,
  type StyleSpecification,
  type GeoJSONSource,
  type MapGeoJSONFeature,
} from 'maplibre-gl';
import { TerraDraw, TerraDrawPolygonMode, TerraDrawLineStringMode, TerraDrawRectangleMode, TerraDrawCircleMode, TerraDrawSelectMode, TerraDrawRenderMode } from 'terra-draw';
import { TerraDrawMapLibreGLAdapter } from 'terra-draw-maplibre-gl-adapter';
import type { Feature, Point } from 'geojson';
import { PARCELS, ALERTS, STATIONS, ROADS, SENSORS, SENSOR_ZONES, type Severity, type AlertProps } from './data';

// MapLibre 6 is ESM-only and resolves its worker relative to import.meta.url, which does
// not survive Vite's bundling. We ship the worker (+ its shared chunk) verbatim under
// demo/public/maplibre/ (see demo/scripts/copy-worker.mjs) and point at it explicitly.
// This must happen before the first Map is constructed.
setWorkerUrl('/maplibre/maplibre-gl-worker.mjs');

// ---------------------------------------------------------------------------
// Style
// ---------------------------------------------------------------------------

const style: StyleSpecification = {
  version: 8,
  // Glyphs are served by the app itself (demo/public/glyphs, Noto Sans, OFL) — still no external network.
  glyphs: location.origin + '/glyphs/{fontstack}/{range}.pbf',
  sources: {
    // Vector TILES: the app only knows a URL template; the data lives "on a server". In tests the
    // tiles are generated from a GeoJSON fixture inside page.route. In manual dev they 404 (empty layer).
    buildings: {
      type: 'vector',
      tiles: [location.origin + '/vt/buildings/{z}/{x}/{y}.pbf'],
      minzoom: 0,
      maxzoom: 14,
    },
    basemap: {
      type: 'raster',
      tiles: [location.origin + '/tiles/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 14,
    },
    parcels: {
      type: 'geojson',
      data: PARCELS as unknown as GeoJSON.GeoJSON,
      promoteId: 'id',
    },
    alerts: {
      type: 'geojson',
      data: ALERTS as unknown as GeoJSON.GeoJSON,
      promoteId: 'id',
    },
    stations: {
      type: 'geojson',
      data: STATIONS as unknown as GeoJSON.GeoJSON,
      cluster: true,
      clusterRadius: 50,
      clusterMaxZoom: 14,
    },
    roads: {
      type: 'geojson',
      data: ROADS as unknown as GeoJSON.GeoJSON,
      promoteId: 'id',
    },
    // "Rendered is not visible" cases. All sensor layers start hidden (toggle in the sidebar).
    sensors: { type: 'geojson', data: SENSORS as unknown as GeoJSON.GeoJSON, promoteId: 'id' },
    'sensor-zones': { type: 'geojson', data: SENSOR_ZONES as unknown as GeoJSON.GeoJSON, promoteId: 'id' },
  },
  layers: [
    {
      id: 'background',
      type: 'background',
      paint: { 'background-color': '#e9eef2' },
    },
    {
      id: 'basemap',
      type: 'raster',
      source: 'basemap',
    },
    {
      id: 'parcels',
      type: 'fill',
      source: 'parcels',
      paint: {
        'fill-color': ['match', ['get', 'zoning'], 'residential', '#8bc34a', 'commercial', '#42a5f5', '#cccccc'],
        'fill-opacity': 0.6,
      },
    },
    {
      id: 'parcels-outline',
      type: 'line',
      source: 'parcels',
      paint: {
        'line-color': '#33475b',
        'line-width': 1,
      },
    },
    {
      id: 'buildings',
      type: 'fill',
      source: 'buildings',
      'source-layer': 'buildings',
      paint: {
        'fill-color': ['match', ['get', 'kind'], 'office', '#8e24aa', '#6d4c41'],
        'fill-opacity': 0.75,
      },
    },
    {
      id: 'roads',
      type: 'line',
      source: 'roads',
      paint: {
        'line-color': '#6d6d6d',
        'line-width': 4,
      },
    },
    {
      id: 'stations-clusters',
      type: 'circle',
      source: 'stations',
      filter: ['has', 'point_count'],
      paint: {
        'circle-radius': 18,
        'circle-color': '#5c6bc0',
        'circle-opacity': 0.85,
        'circle-stroke-width': 2,
        'circle-stroke-color': '#ffffff',
      },
    },
    {
      id: 'stations-points',
      type: 'symbol',
      source: 'stations',
      filter: ['!', ['has', 'point_count']],
      layout: {
        'icon-image': 'station-icon',
        'icon-allow-overlap': true,
      },
    },
    {
      id: 'stations-cluster-count',
      type: 'symbol',
      source: 'stations',
      filter: ['has', 'point_count'],
      layout: {
        'text-field': ['to-string', ['get', 'point_count']],
        'text-font': ['Noto Sans Regular'],
        'text-size': 13,
        'text-allow-overlap': true,
      },
      paint: { 'text-color': '#ffffff' },
    },
    {
      id: 'alerts',
      type: 'circle',
      source: 'alerts',
      paint: {
        'circle-radius': 10,
        'circle-color': ['match', ['get', 'severity'], 'high', '#d32f2f', 'medium', '#f9a825', 'low', '#1976d2', '#999999'],
        'circle-stroke-width': 2,
        'circle-stroke-color': '#ffffff',
      },
    },
    {
      // Invisible hit areas: a common real-world trick (fill-opacity 0 so clicks near a sensor count).
      id: 'sensor-zones',
      type: 'fill',
      source: 'sensor-zones',
      layout: { visibility: 'none' },
      paint: { 'fill-color': '#000000', 'fill-opacity': 0 },
    },
    {
      // Archived (data) or muted (feature-state) sensors are hidden by a data-driven paint expression,
      // not by a filter: MapLibre still reports them as rendered.
      id: 'sensors',
      type: 'circle',
      source: 'sensors',
      filter: ['!=', ['get', 'kind'], 'ghost'],
      layout: { visibility: 'none' },
      paint: {
        'circle-radius': 9,
        'circle-color': '#00897b',
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 2,
        'circle-opacity': ['case', ['any', ['==', ['get', 'status'], 'archived'], ['boolean', ['feature-state', 'muted'], false]], 0, 1],
        'circle-stroke-opacity': ['case', ['any', ['==', ['get', 'status'], 'archived'], ['boolean', ['feature-state', 'muted'], false]], 0, 1],
      },
    },
    {
      // The style says "draw an icon", but the icon image is fully transparent: only pixels can tell.
      id: 'sensors-ghost',
      type: 'symbol',
      source: 'sensors',
      filter: ['==', ['get', 'kind'], 'ghost'],
      layout: { visibility: 'none', 'icon-image': 'ghost-icon', 'icon-allow-overlap': true },
    },
    {
      // Default collision behaviour on purpose: labels that collide are hidden, like a real app.
      id: 'alerts-labels',
      type: 'symbol',
      source: 'alerts',
      layout: {
        'text-field': ['get', 'name'],
        'text-font': ['Noto Sans Regular'],
        'text-size': 12,
        'text-offset': [0, 1.5],
        'text-anchor': 'top',
      },
      paint: { 'text-color': '#263238', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 },
    },
  ],
};

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------

const map = new MlMap({
  container: 'map',
  center: [34.78, 32.08],
  zoom: 12,
  style,
  attributionControl: false,
});

// Test hook — required by the Playwright map-testing library.
((window as any).__geowright_maps ??= {}).main = map;

// Shift+click selects alerts. MapLibre's box-zoom handler claims shift+mousedown and the map then
// never emits 'click', so apps with shift-click selection disable it (mapbox-gl-draw does the same).
map.boxZoom.disable();

// ---------------------------------------------------------------------------
// Alert state + async CRUD
// ---------------------------------------------------------------------------

let alertFeatures: Feature<Point, AlertProps>[] = ALERTS.features.map((f) => ({ ...f }));

function alertsSource(): GeoJSONSource {
  return map.getSource('alerts') as GeoJSONSource;
}

function nextAlertId(): number {
  return alertFeatures.reduce((max, f) => Math.max(max, f.properties!.id), 0) + 1;
}

function randomDelay(): number {
  return 100 + Math.random() * 300;
}

function addAlertAsync(name: string, severity: Severity, lng: number, lat: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => {
      const id = nextAlertId();
      alertFeatures.push({
        type: 'Feature',
        id,
        geometry: { type: 'Point', coordinates: [lng, lat] },
        properties: { id, name, severity },
      });
      alertsSource().setData({ type: 'FeatureCollection', features: alertFeatures } as unknown as GeoJSON.GeoJSON);
      renderAlertList();
      resolve();
    }, randomDelay());
  });
}

function removeAlertAsync(id: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => {
      alertFeatures = alertFeatures.filter((f) => f.properties!.id !== id);
      alertsSource().setData({ type: 'FeatureCollection', features: alertFeatures } as unknown as GeoJSON.GeoJSON);
      renderAlertList();
      resolve();
    }, randomDelay());
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const alertListEl = document.getElementById('alert-list')!;

function renderAlertList(): void {
  alertListEl.innerHTML = alertFeatures
    .map((f) => {
      const p = f.properties!;
      return `<div class="alert-row" data-testid="alert-row-${p.id}">
        <span>${escapeHtml(p.name)} — <span class="sev-${p.severity}">${p.severity}</span></span>
        <button data-testid="alert-remove-${p.id}">Remove</button>
      </div>`;
    })
    .join('');
}

alertListEl.addEventListener('click', (ev) => {
  const btn = (ev.target as HTMLElement).closest('button[data-testid^="alert-remove-"]') as HTMLButtonElement | null;
  if (!btn) return;
  const id = Number(btn.dataset.testid!.slice('alert-remove-'.length));
  removeAlertAsync(id);
});

renderAlertList();

const alertForm = document.getElementById('alert-form') as HTMLFormElement;
alertForm.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const name = (document.querySelector('[data-testid="alert-name"]') as HTMLInputElement).value;
  const severity = (document.querySelector('[data-testid="alert-severity"]') as HTMLSelectElement).value as Severity;
  const lng = parseFloat((document.querySelector('[data-testid="alert-lng"]') as HTMLInputElement).value);
  const lat = parseFloat((document.querySelector('[data-testid="alert-lat"]') as HTMLInputElement).value);
  addAlertAsync(name, severity, lng, lat).then(() => alertForm.reset());
});

// ---------------------------------------------------------------------------
// Popup on click (alerts win over parcels), suppressed while drawing
// ---------------------------------------------------------------------------

let drawModeActive = false;
let popup: Popup | null = null;
const selection = new Set<number>();
const selectionEl = document.querySelector('[data-testid="selection"]') as HTMLElement;
const hoverEl = document.querySelector('[data-testid="hover-info"]') as HTMLElement;

// Hover feedback: pointer cursor + name of the alert under the mouse.
map.on('mousemove', (e) => {
  const f = map.queryRenderedFeatures(e.point, { layers: ['alerts'] })[0];
  map.getCanvas().style.cursor = f ? 'pointer' : '';
  hoverEl.textContent = f ? String((f.properties as any).name) : '';
});

map.on('click', (e) => {
  if (drawModeActive) return;

  const features = map.queryRenderedFeatures(e.point, { layers: ['alerts', 'parcels', 'buildings'] });

  if (popup) {
    popup.remove();
    popup = null;
  }

  if (features.length === 0) return;

  const alertFeature = features.find((f: MapGeoJSONFeature) => f.layer.id === 'alerts');
  const parcelFeature = features.find((f: MapGeoJSONFeature) => f.layer.id === 'parcels');

  const buildingFeature = features.find((f: MapGeoJSONFeature) => f.layer.id === 'buildings');

  // Shift+click on an alert toggles it in the selection instead of opening a popup.
  if (alertFeature && e.originalEvent.shiftKey) {
    const id = Number((alertFeature.properties as any).id);
    if (selection.has(id)) selection.delete(id);
    else selection.add(id);
    selectionEl.textContent = [...selection].sort((a, b) => a - b).join(',');
    return;
  }

  let html: string | null = null;
  if (alertFeature) {
    const p = alertFeature.properties as any;
    html = `<div data-testid="popup" data-kind="alert" data-id="${p.id}"><strong>${escapeHtml(p.name)}</strong><br/>Severity: ${p.severity}</div>`;
  } else if (buildingFeature) {
    const p = buildingFeature.properties as any;
    html = `<div data-testid="popup" data-kind="building" data-id="${p.id}"><strong>Building ${p.id}</strong><br/>Kind: ${p.kind}<br/>Floors: ${p.floors}</div>`;
  } else if (parcelFeature) {
    const p = parcelFeature.properties as any;
    html = `<div data-testid="popup" data-kind="parcel" data-id="${p.id}"><strong>Parcel ${p.id}</strong><br/>Owner: ${escapeHtml(p.owner)}<br/>Zoning: ${p.zoning}</div>`;
  }

  if (html) {
    popup = new Popup().setLngLat(e.lngLat).setHTML(html).addTo(map);
  }
});

// ---------------------------------------------------------------------------
// Layer toggles
// ---------------------------------------------------------------------------

function wireToggle(testId: string, layerIds: string[]) {
  const el = document.querySelector(`[data-testid="${testId}"]`) as HTMLInputElement;
  el.addEventListener('change', () => {
    const visibility = el.checked ? 'visible' : 'none';
    for (const id of layerIds) map.setLayoutProperty(id, 'visibility', visibility);
  });
}

// ---------------------------------------------------------------------------
// Basemap switcher: a new basemap style from the server, the app's own layers kept on top
// ---------------------------------------------------------------------------

// Light / dark basemap switchers are among the most common map UIs. The basemap is a style of its own, loaded from its
// URL: setStyle(url, { diff: false }) throws the old style away at once, and the map has no style until the new one is
// in. transformStyle (MapLibre's documented way) puts the app's sources and layers back on top of the new basemap; the
// images the app added go with the old style, so they are added again once the new one has loaded. Like the tiles, the
// basemap styles live "on a server": in tests page.route answers them (tests/basemaps.ts); in manual dev they 404.
let basemap = { sources: ['basemap'], layers: ['background', 'basemap'] }; // what the current basemap brought
(document.querySelector('[data-testid="basemap"]') as HTMLSelectElement).addEventListener('change', (ev) => {
  const name = (ev.target as HTMLSelectElement).value;
  map.once('style.load', addAppImages);
  map.setStyle(`${location.origin}/basemaps/${name}.json`, {
    diff: false,
    transformStyle: (previous, next) => {
      const own = { sources: Object.entries(previous?.sources ?? {}).filter(([id]) => !basemap.sources.includes(id)), layers: (previous?.layers ?? []).filter((l) => !basemap.layers.includes(l.id)) };
      basemap = { sources: Object.keys(next.sources), layers: next.layers.map((l) => l.id) };
      return { ...next, glyphs: previous?.glyphs ?? next.glyphs, sources: { ...next.sources, ...Object.fromEntries(own.sources) }, layers: [...next.layers, ...own.layers] };
    },
  });
});

// ---------------------------------------------------------------------------
// Sensors: hidden through paint, by data (archive) or by feature-state (mute)
// ---------------------------------------------------------------------------

let sensorData = SENSORS;
(document.querySelector('[data-testid="sensor-archive-501"]') as HTMLButtonElement).addEventListener('click', () => {
  setTimeout(() => {
    sensorData = {
      ...sensorData,
      features: sensorData.features.map((f) => (f.properties.id === 501 ? { ...f, properties: { ...f.properties, status: f.properties.status === 'archived' ? 'active' : 'archived' } } : f)),
    };
    (map.getSource('sensors') as GeoJSONSource).setData(sensorData as unknown as GeoJSON.GeoJSON);
  }, randomDelay());
});
(document.querySelector('[data-testid="sensor-mute-503"]') as HTMLButtonElement).addEventListener('click', () => {
  const muted = !!map.getFeatureState({ source: 'sensors', id: 503 }).muted;
  map.setFeatureState({ source: 'sensors', id: 503 }, { muted: !muted });
});

// ---------------------------------------------------------------------------
// DOM markers (maplibregl.Marker): real apps mix these with canvas features
// ---------------------------------------------------------------------------

const markerInfoEl = document.querySelector('[data-testid="marker-info"]') as HTMLElement;
function buildMarkers(): Marker[] {
  // custom element, own popup, draggable: reports where it was dropped
  const hqEl = document.createElement('div');
  hqEl.className = 'hq-marker';
  hqEl.dataset.testid = 'marker-hq';
  hqEl.textContent = 'HQ';
  hqEl.style.cssText = 'background:#4527a0;color:#fff;font:bold 11px system-ui;padding:3px 6px;border-radius:10px;cursor:pointer;';
  const hq = new Marker({ element: hqEl, draggable: true })
    .setLngLat([34.84, 32.12])
    .setPopup(new Popup({ offset: 14 }).setHTML('<div data-testid="hq-popup"><strong>Depot HQ</strong></div>'));
  hq.on('dragend', () => {
    const l = hq.getLngLat();
    markerInfoEl.textContent = `hq moved to ${l.lng.toFixed(4)},${l.lat.toFixed(4)}`;
  });
  // default pins sitting ON canvas features: over the middle of parcel 103, and hiding tiny parcel 106
  const onParcel = new Marker({ color: '#c62828' }).setLngLat([34.805, 32.1]);
  const onTiny = new Marker({ color: '#2e7d32' }).setLngLat([34.8, 32.0595]);
  for (const [name, m] of [['pin-103', onParcel], ['pin-106', onTiny]] as const) {
    m.getElement().dataset.testid = `marker-${name}`;
    m.getElement().addEventListener('click', (ev) => {
      ev.stopPropagation(); // a marker click is not a map click
      markerInfoEl.textContent = `${name} clicked`;
    });
  }
  return [hq, onParcel, onTiny];
}
let markers: Marker[] | undefined;
(document.querySelector('[data-testid="toggle-markers"]') as HTMLInputElement).addEventListener('change', (ev) => {
  const on = (ev.target as HTMLInputElement).checked;
  markers ??= buildMarkers();
  for (const m of markers) on ? m.addTo(map) : m.remove();
});

// ---------------------------------------------------------------------------
// Clusters
// ---------------------------------------------------------------------------

map.on('click', 'stations-clusters', async (e) => {
  if (drawModeActive) return;
  const features = map.queryRenderedFeatures(e.point, { layers: ['stations-clusters'] });
  const clusterId = features[0]?.properties?.cluster_id;
  if (clusterId == null) return;
  const source = map.getSource('stations') as GeoJSONSource;
  const zoom = await source.getClusterExpansionZoom(clusterId);
  const coords = (features[0].geometry as Point).coordinates as [number, number];
  map.easeTo({ center: coords, zoom });
});

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------

const ctxMenu = document.getElementById('ctx-menu')!;
const ctxCoordsEl = ctxMenu.querySelector('[data-testid="ctx-coords"]') as HTMLElement;
const ctxAddAlertBtn = ctxMenu.querySelector('[data-testid="ctx-add-alert"]') as HTMLButtonElement;
const ctxCenterBtn = ctxMenu.querySelector('[data-testid="ctx-center-here"]') as HTMLButtonElement;
let ctxLngLat: { lng: number; lat: number } | null = null;

function closeCtxMenu() {
  ctxMenu.classList.add('hidden');
}

map.on('contextmenu', (e) => {
  e.preventDefault();
  e.originalEvent.preventDefault();
  ctxLngLat = { lng: e.lngLat.lng, lat: e.lngLat.lat };
  ctxCoordsEl.textContent = `${e.lngLat.lng.toFixed(5)}, ${e.lngLat.lat.toFixed(5)}`;
  ctxMenu.style.left = `${e.originalEvent.pageX}px`;
  ctxMenu.style.top = `${e.originalEvent.pageY}px`;
  ctxMenu.classList.remove('hidden');
});

ctxAddAlertBtn.addEventListener('click', () => {
  if (ctxLngLat) {
    addAlertAsync('Alert from menu', 'medium', ctxLngLat.lng, ctxLngLat.lat);
  }
  closeCtxMenu();
});

ctxCenterBtn.addEventListener('click', () => {
  if (ctxLngLat) {
    map.flyTo({ center: [ctxLngLat.lng, ctxLngLat.lat] });
  }
  closeCtxMenu();
});

document.addEventListener('click', (ev) => {
  if (ctxMenu.classList.contains('hidden')) return;
  if (ctxMenu.contains(ev.target as Node)) return;
  closeCtxMenu();
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') closeCtxMenu();
});

// ---------------------------------------------------------------------------
// Camera buttons + view state footer
// ---------------------------------------------------------------------------

(document.querySelector('[data-testid="fly-home"]') as HTMLButtonElement).addEventListener('click', () => {
  map.flyTo({ center: [34.78, 32.08], zoom: 12 });
});

(document.querySelector('[data-testid="fly-east"]') as HTMLButtonElement).addEventListener('click', () => {
  map.flyTo({ center: [35.2, 32.08], zoom: 12 });
});

// Camera presets: everything else in the demo is north-up and flat; real apps are not.
const PRESETS: Record<string, { projection: 'mercator' | 'globe'; zoom: number; bearing: number; pitch: number }> = {
  'north-up': { projection: 'mercator', zoom: 12, bearing: 0, pitch: 0 },
  tilted: { projection: 'mercator', zoom: 12, bearing: 35, pitch: 55 },
  'globe-6': { projection: 'globe', zoom: 6, bearing: 0, pitch: 0 },
  'globe-2': { projection: 'globe', zoom: 1.8, bearing: 0, pitch: 0 },
};
(document.querySelector('[data-testid="camera-preset"]') as HTMLSelectElement).addEventListener('change', (ev) => {
  const p = PRESETS[(ev.target as HTMLSelectElement).value];
  map.setProjection({ type: p.projection });
  map.easeTo({ center: [34.78, 32.08], zoom: p.zoom, bearing: p.bearing, pitch: p.pitch, duration: 600 });
});

const viewStateEl = document.querySelector('[data-testid="view-state"]') as HTMLElement;
function updateViewState() {
  const c = map.getCenter();
  viewStateEl.textContent = `${c.lng.toFixed(5)},${c.lat.toFixed(5)},${map.getZoom().toFixed(2)}`;
}
map.on('move', updateViewState);
updateViewState();

// ---------------------------------------------------------------------------
// Station icon (generated ImageData, no network)
// ---------------------------------------------------------------------------

function makeStationIcon(): ImageData {
  const size = 24;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, size, size);
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, 9, 0, Math.PI * 2);
  ctx.fillStyle = '#2e7d32';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, 3, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  return ctx.getImageData(0, 0, size, size);
}

/** The images the app's layers use. Images belong to a style: a new style (a basemap switch) needs them added again. */
function addAppImages(): void {
  if (!map.hasImage('station-icon')) map.addImage('station-icon', makeStationIcon());
  if (!map.hasImage('ghost-icon')) map.addImage('ghost-icon', new ImageData(24, 24)); // all pixels rgba(0,0,0,0)
}

// ---------------------------------------------------------------------------
// Terra Draw
// ---------------------------------------------------------------------------

let terraDraw: TerraDraw | undefined;

const drawCountEl = document.querySelector('[data-testid="draw-count"]') as HTMLElement;
const drawJsonEl = document.querySelector('[data-testid="draw-json"]') as HTMLElement;

function refreshDrawUI() {
  if (!terraDraw) return;
  const all = terraDraw.getSnapshot();
  const polygons = all.filter((f) => f.geometry.type === 'Polygon');
  drawCountEl.textContent = String(polygons.length);
  drawCountEl.dataset.total = String(all.filter((f) => !f.properties.midPoint && !f.properties.selectionPoint && !f.properties.closingPoint).length);
  drawJsonEl.textContent = JSON.stringify(polygons.map((f) => ({ geometry: f.geometry, id: f.id })));
}

(document.querySelector('[data-testid="draw-polygon"]') as HTMLButtonElement).addEventListener('click', () => {
  if (!terraDraw) return;
  drawModeActive = true;
  terraDraw.setMode('polygon');
});

for (const mode of ['line', 'rectangle', 'circle'] as const) {
  (document.querySelector(`[data-testid="draw-${mode}"]`) as HTMLButtonElement).addEventListener('click', () => {
    if (!terraDraw) return;
    drawModeActive = true;
    terraDraw.setMode(mode === 'line' ? 'linestring' : mode);
  });
}

(document.querySelector('[data-testid="draw-select"]') as HTMLButtonElement).addEventListener('click', () => {
  if (!terraDraw) return;
  drawModeActive = true;
  terraDraw.setMode('select');
});

(document.querySelector('[data-testid="draw-off"]') as HTMLButtonElement).addEventListener('click', () => {
  if (!terraDraw) return;
  drawModeActive = false;
  terraDraw.setMode('static');
});

(document.querySelector('[data-testid="draw-clear"]') as HTMLButtonElement).addEventListener('click', () => {
  if (!terraDraw) return;
  terraDraw.clear();
  refreshDrawUI();
});

// ---------------------------------------------------------------------------
// Wire up things that need the style to be loaded
// ---------------------------------------------------------------------------

map.on('load', () => {
  addAppImages();

  wireToggle('toggle-parcels', ['parcels', 'parcels-outline']);
  wireToggle('toggle-alerts', ['alerts', 'alerts-labels']);
  wireToggle('toggle-stations', ['stations-clusters', 'stations-cluster-count', 'stations-points']);
  wireToggle('toggle-roads', ['roads']);
  wireToggle('toggle-buildings', ['buildings']);
  wireToggle('toggle-sensors', ['sensor-zones', 'sensors', 'sensors-ghost']);

  const adapter = new TerraDrawMapLibreGLAdapter({ map });
  terraDraw = new TerraDraw({
    adapter,
    modes: [
      new TerraDrawPolygonMode(),
      new TerraDrawLineStringMode(),
      new TerraDrawRectangleMode(), // default interaction: click, move, click
      new TerraDrawCircleMode({ drawInteraction: 'click-drag' }), // press, drag, release
      new TerraDrawSelectMode({
        flags: Object.fromEntries(
          ['polygon', 'linestring', 'rectangle', 'circle'].map((mode) => [
            mode,
            { feature: { draggable: true, coordinates: { draggable: true, midpoints: { draggable: true }, deletable: true } } },
          ]),
        ),
      }),
      new TerraDrawRenderMode({ modeName: 'static', styles: {} }),
    ],
  });
  terraDraw.start();
  terraDraw.setMode('static');
  terraDraw.on('change', refreshDrawUI);
  terraDraw.on('finish', refreshDrawUI);
  refreshDrawUI();
});
