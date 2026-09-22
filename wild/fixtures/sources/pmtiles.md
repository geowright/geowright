# Synthetic PMTiles fixture for Protomaps' MapLibre example

The upstream example requests `https://pmtiles.io/protomaps(vector)ODbL_firenze.pmtiles`. That archive is ODbL-derived and is **not copied or fetched in tests**. `tests/wild/pmtiles.spec.ts` routes the URL to `pmtiles/synthetic-firenze.pmtiles`, a first-party synthetic PMTiles v3 archive with 12 addressed zoom-13 MVT tiles and the source-layer names the example expects: `water`, `buildings`, `roads`, and `pois`.

The coordinates are placed near the example's existing Firenze camera, but the features, names, polygons, lines, and points are made up for this test. No MapTiler, OSM, Protomaps sample, or other third-party tile data is present. `pmtiles/generate-mbtiles.mjs` produces the MBTiles input using `@maplibre/geojson-vt` and `@maplibre/vt-pbf`; the committed PMTiles archive was converted with `pmtiles` 1.31.2 (BSD-3-Clause) and passed `pmtiles verify`. SHA-256: `da69bbb3719bbf422d3b281cca42953f5cf6d2c0e92094c171ad1aed8404fb9e`.

The route handler answers byte-range requests with `206` and `Content-Range`. The original app URL stays in its source; the wild harness aborts and reports any external request the spec does not route.
