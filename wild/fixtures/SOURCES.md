# Fixture sources and licenses

Every file here answers a network request of a vendored app. Permissive / public-domain only.
Recorded 2026-09-20. `sha256` = first 16 hex digits.

| file | what the app asked for | origin / license | size | sha256 |
|---|---|---|---|---|
| `demotiles/style.json`, `demotiles/tiles/tiles.json`, `demotiles/tiles/{0..3}/**.pbf` | `https://demotiles.maplibre.org/…` | `maplibre/demotiles` @ `601ae60796ce` (gh-pages), **BSD-3-Clause** (`demotiles/LICENSE`); tile data built from **Natural Earth** (public domain). Only z0–3 committed; TileJSON served with `maxzoom: 3`. | 1.6 MB | — |
| `earthquakes.geojson` | `https://maplibre.org/maplibre-gl-js/docs/assets/earthquakes.geojson` | asset of `maplibre/maplibre-gl-js` (**BSD-3-Clause**); data: **USGS** earthquake catalogue (US government work, public domain) | 1.2 MB | `309837956f52df2c` |
| `us_states.geojson` | `https://maplibre.org/maplibre-gl-js/docs/assets/us_states.geojson` | asset of `maplibre/maplibre-gl-js` (**BSD-3-Clause**); state outlines, US-Census-style public-domain data (provenance beyond the repo not traced) | 81 KB | `7ed671b49a12c7bc` |

Generated at test time, not files: raster tiles (`tests/tile-png.ts`), sprites (`tests/wild/png.ts`), the
synthetic "bright" basemap and its city (`tests/wild/basemap.ts`). Glyphs: Noto Sans Regular 0–255
(OFL) from `demo/public/glyphs`.

NOT committable, and therefore substituted or skipped (checked 2026-09-20): OpenFreeMap / any
OSM-derived tiles (ODbL) and the OSM Bright design (CC-BY); MapTiler tiles (proprietary, key); OSM
raster tiles (ODbL + tile policy); Mapterhorn terrain (mostly CC-BY); Wikimedia `201408_cat.png`
(CC-BY-4.0); `static-assets.mapbox.com/…/drone.mp4|webm` (no license found).
