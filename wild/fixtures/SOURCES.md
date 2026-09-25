# Fixture sources and licenses

Every file here answers a network request of a vendored app. Permissive / public-domain only.
Recorded 2026-09-20. `sha256` = first 16 hex digits.

| file | what the app asked for | origin / license | size | sha256 |
|---|---|---|---|---|
| `demotiles/style.json`, `demotiles/tiles/tiles.json`, `demotiles/tiles/{0..3}/**.pbf` | `https://demotiles.maplibre.org/…` | `maplibre/demotiles` @ `601ae60796ce` (gh-pages), **BSD-3-Clause** (`demotiles/LICENSE`); tile data built from **Natural Earth** (public domain). Only z0–3 committed; TileJSON served with `maxzoom: 3`. | 1.6 MB | — |
| `earthquakes.geojson` | `https://maplibre.org/maplibre-gl-js/docs/assets/earthquakes.geojson` | asset of `maplibre/maplibre-gl-js` (**BSD-3-Clause**); data: **USGS** earthquake catalogue (US government work, public domain) | 1.2 MB | `309837956f52df2c` |
| `us_states.geojson` | `https://maplibre.org/maplibre-gl-js/docs/assets/us_states.geojson` | asset of `maplibre/maplibre-gl-js` (**BSD-3-Clause**); state outlines, US-Census-style public-domain data (provenance beyond the repo not traced) | 81 KB | `7ed671b49a12c7bc` |

More fixtures, one record per app that needed them (`sources/*.md`, same columns):

| record | what it covers | licence |
|---|---|---|
| `sources/animate-a-series-of-images.md` | `radar0–4.gif` | BSD-3 (maplibre-gl-js repo assets) |
| `sources/center-the-map-on-a-clicked-symbol.md` | `custom_marker.png` | BSD-3 (maplibre-gl-js repo asset) |
| `sources/update-a-feature-in-realtime.md` | `hike.geojson` (provenance beyond the repo not traced), `vendor/d3@3/` | BSD-3 repo asset; d3 v3: BSD-3 (LICENSE kept) |
| `sources/show-polygon-information-on-click.md` | `ne_110m_admin_1_states_provinces_shp.geojson` | Natural Earth — public domain |
| `sources/measure-distances.md` | `vendor/turf@7/turf.min.js` (also served, wrapped as an ES module, for the mapbox-gl-draw example's `esm.sh` import) | Turf: MIT (LICENSE kept). The bundle also contains JSTS, `(EDL-1.0 OR EPL-1.0)`, used under EDL-1.0 (BSD-3-Clause text), and MIT / ISC / BSD-2 / BSD-3 / Unlicense dependencies: every text in `vendor/turf@7/THIRD_PARTY_LICENSES.md` |
| `sources/draw-geometries-with-terra-draw.md` | `vendor/maplibre-gl-terradraw@1.0.1/` (UMD + CSS) | The plugin: MIT (LICENSE kept). The bundle also contains terra-draw 1.0.0 and its MapLibre adapter 1.0.1 (MIT, with code adapted from MIT / ISC packages) and six `@turf/*` 7.2.0 modules (MIT); the CSS inlines Material Symbols icons (Apache-2.0): every text in `vendor/maplibre-gl-terradraw@1.0.1/THIRD_PARTY_LICENSES.md` |
| `sources/react-map-gl.md` | `react-map-gl/us-income.geojson`, `react-map-gl/counties.KS-NE-OK.json` (trimmed from 6 MB) | MIT ×2 (LICENSE files kept) |
| `sources/deck-gl.md` | deck.gl app's CARTO style and POI data requests, answered by generated test data | Synthetic data, no copied third-party asset |
| `sources/pmtiles.md` | Protomaps example's ODbL Firenze archive URL, answered by `pmtiles/synthetic-firenze.pmtiles` | First-party synthetic MVT data in a PMTiles v3 container; no upstream tile data |

Served from `node_modules` rather than copied: `@mapbox/mapbox-gl-draw` 1.5.2 JS + CSS (ISC) for the example
that asks unpkg for 1.5.0; `maplibre-gl.css` 6.10.0 (BSD-3) for svelte-maplibre-gl, which links it from unpkg.

Generated at test time, not files: raster tiles (`tests/tile-png.ts`), sprites and road shields (`tests/wild/png.ts`), the
synthetic "bright" / CARTO / MapTiler-streets basemaps with their city and surrounding region (`tests/wild/basemap.ts`), the synthetic Terrarium DEM (`tests/wild/terrain.ts`). Glyphs: Noto Sans Regular 0–255
(OFL, notice and text in `demo/public/glyphs/OFL.txt`) from `demo/public/glyphs`.

NOT committable, and therefore substituted or skipped (checked 2026-09-20): OpenFreeMap / any
OSM-derived tiles (ODbL) and the OSM Bright design (CC-BY); MapTiler tiles (proprietary, key); OSM
raster tiles (ODbL + tile policy); Mapterhorn terrain (mostly CC-BY); Wikimedia `201408_cat.png`
(CC-BY-4.0); `static-assets.mapbox.com/…/drone.mp4|webm` (no license found).
