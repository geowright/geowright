# deck.gl MapboxOverlay fixture routes

| URL requested by the upstream app | Test response | License / provenance |
|---|---|---|
| `https://basemaps.cartocdn.com/gl/positron-gl-style/style.json` and its Carto tile/glyph dependencies | `cartoBasemap('positron', [-74.012, 40.705])` in `tests/wild/basemap.ts` | Synthetic style and generated city; glyphs are Noto Sans Regular (OFL), already recorded in `wild/fixtures/SOURCES.md` |
| `https://raw.githubusercontent.com/visgl/deck.gl-data/master/examples/trips/pois.json` | Two synthetic `{ coordinates: [lng, lat] }` points in `tests/wild/deck-gl.spec.ts` | Generated test data; no upstream POI file is copied |

The upstream URLs stay in the vendored app. `page.route` intercepts them before the browser can fetch them; the wild harness aborts and reports anything else external.
