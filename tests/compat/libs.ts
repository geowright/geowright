/**
 * The MapLibre / Mapbox-GL-v1-API versions the compat matrix runs against. Installed under npm aliases
 * (package.json devDependencies) so they sit side by side; all BSD-3-Clause. mapbox-gl is pinned to the
 * 1.13 line ON PURPOSE: v2 and later are proprietary and must never be installed here.
 */
export interface Lib {
  /** npm alias = directory under node_modules = `?lib=` of the compat page. */
  alias: string;
  label: string;
  /** Global the UMD build defines; undefined = ESM only (MapLibre 6). */
  global?: 'maplibregl' | 'mapboxgl';
}

export const LIBS: Lib[] = [
  { alias: 'mapbox-gl-1', label: 'Mapbox GL JS 1.13 (BSD)', global: 'mapboxgl' },
  { alias: 'maplibre-gl-2', label: 'MapLibre GL JS 2', global: 'maplibregl' },
  { alias: 'maplibre-gl-3', label: 'MapLibre GL JS 3', global: 'maplibregl' },
  { alias: 'maplibre-gl-4', label: 'MapLibre GL JS 4', global: 'maplibregl' },
  { alias: 'maplibre-gl-5', label: 'MapLibre GL JS 5', global: 'maplibregl' },
  { alias: 'maplibre-gl', label: 'MapLibre GL JS 6' },
];
