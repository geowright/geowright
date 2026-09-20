# Fixtures for `update-a-feature-in-realtime`

| file | what the app asked for | origin / license / evidence | size | sha256 |
|---|---|---|---|---|
| `wild/fixtures/hike.geojson` | `https://maplibre.org/maplibre-gl-js/docs/assets/hike.geojson` | asset of `maplibre/maplibre-gl-js` (**BSD-3-Clause**), same repo as `earthquakes.geojson` / `us_states.geojson` already vendored; evidence: `wild/fixtures/SOURCES.md`, `maplibre-examples/LICENSE.txt` | 462 KB | `1c84d0f903dc4d65` |
| `wild/fixtures/vendor/d3@3/d3.v3.min.js` | `https://d3js.org/d3.v3.min.js` | `d3/d3` @ tag `v3.5.17`, **BSD-3-Clause** (Michael Bostock); LICENSE saved alongside, fetched from `https://raw.githubusercontent.com/d3/d3/v3.5.17/LICENSE` | 152 KB | `76c39718d1c0a3fb` |
| `wild/fixtures/vendor/d3@3/LICENSE` | (license file for the above, not itself fetched by the app) | `https://raw.githubusercontent.com/d3/d3/v3.5.17/LICENSE` | 1.4 KB | — |

Basemap: `https://tiles.openfreemap.org/styles/bright` — served by `brightBasemap(center)` (synthetic
stand-in, see `tests/wild/basemap.ts`), not a new fixture.
