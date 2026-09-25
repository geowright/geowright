# Fixtures for `draw-geometries-with-terra-draw`

| file | what the app asked for | origin / license / evidence | size | sha256 |
|---|---|---|---|---|
| `wild/fixtures/vendor/maplibre-gl-terradraw@1.0.1/maplibre-gl-terradraw.umd.js` | `https://cdn.jsdelivr.net/npm/@watergis/maplibre-gl-terradraw@1.0.1/dist/maplibre-gl-terradraw.umd.js` | `@watergis/maplibre-gl-terradraw@1.0.1` npm package (`watergis/maplibre-gl-terradraw` on GitHub), **MIT** — confirmed via `npm view @watergis/maplibre-gl-terradraw@1.0.1 license` | 145 KB | — |
| `wild/fixtures/vendor/maplibre-gl-terradraw@1.0.1/maplibre-gl-terradraw.css` | `https://cdn.jsdelivr.net/npm/@watergis/maplibre-gl-terradraw@1.0.1/dist/maplibre-gl-terradraw.css` | same package/version, **MIT** | 12 KB | — |
| `wild/fixtures/vendor/maplibre-gl-terradraw@1.0.1/LICENSE` | (license file, not itself fetched by the app) | `https://unpkg.com/@watergis/maplibre-gl-terradraw@1.0.1/LICENSE` (Copyright (c) 2024 Jin Igarashi) | 1.1 KB | — |
| `wild/fixtures/vendor/maplibre-gl-terradraw@1.0.1/THIRD_PARTY_LICENSES.md` | (notices for the above, not fetched by the app) | the license texts of what the UMD bundle and the CSS contain besides the plugin, established from the source map in the plugin's npm tarball (the UMD there is byte-identical to ours): `terra-draw` 1.0.0 and `terra-draw-maplibre-gl-adapter` 1.0.1 (**MIT**; neither npm package ships a license file, so the copyright line is the `package.json` author, James Milner — the upstream `LICENSE` was not read), the code terra-draw adapted from `geojson-polygon-self-intersections`, `which-polygon`, `rbush`, `quickselect` (MIT / ISC), six `@turf/*` 7.2.0 modules (**MIT**), and the Material Symbols icons the CSS inlines (**Apache-2.0**, identified by their SVG form). Each text from the package's npm tarball. Written 2026-09-25 | 21 KB | — |

Basemap: `https://tiles.openfreemap.org/styles/bright` — served by `brightBasemap(center)` (synthetic
stand-in, see `tests/wild/basemap.ts`), not a new fixture.
