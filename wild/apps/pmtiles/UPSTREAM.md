# Upstream: protomaps/PMTiles MapLibre example

- Repository: https://github.com/protomaps/PMTiles
- Pinned commit: `aec8fa1341222fdddb3318e9ffa8e18e19b312f7` (`main`, fetched 2026-09-22)
- Source: `js/examples/maplibre.html`
- License: BSD-3-Clause for the reference implementation; the PMTiles specification is public domain/CC0 where
  applicable. The pinned root `LICENSE` is retained byte-for-byte as [`LICENSE`](./LICENSE).

## Source mapping and the one-line change

[`index.html`](./index.html) is the pinned upstream `js/examples/maplibre.html` with exactly one added line after
the existing `new maplibregl.Map({...})` expression:

```diff
             });
+            ((window.__geowright_maps ??= {}).main = map);
             map.showTileBoundaries = true;
```

The upstream URL remains the original hosted Firenze archive. That archive is ODbL-derived and is not committed or
used by the tests; the wild spec will intercept the URL and answer it from a separately generated synthetic PMTiles
archive.

## Build

From this directory:

```sh
npm install
npm run build
```

`scripts/build.mjs` is geowright build boilerplate. It copies the unchanged upstream `index.html` into `dist/` and
copies the pinned browser assets into `dist/vendor/`:

```text
dist/index.html
dist/vendor/maplibre-gl.js
dist/vendor/maplibre-gl.css
dist/vendor/maplibre-gl.LICENSE.txt
dist/vendor/pmtiles.js
dist/vendor/fflate.LICENSE
```

The HTML deliberately retains the upstream unpkg URLs. Tests can route those exact URLs to the app-local files using
absolute paths; no CDN request is allowed to escape the harness. No Playwright test or server is run by this build.

## Dependencies and license audit

- `pmtiles@4.5.0`: BSD-3-Clause; `fflate`: MIT.
- `maplibre-gl@5.13.0`: BSD-3-Clause and MapLibre/Mapbox dependency notices.
- The build keeps MapLibre's full `LICENSE.txt` and bundled `fflate`'s MIT `LICENSE` beside the browser assets.
- Installed transitive packages were checked from their package metadata: MIT, BSD-2/3-Clause, ISC, and
  `(MIT OR Apache-2.0)` only. No CC-BY, GPL, LGPL, AGPL, MPL, EPL, CDDL, or SSPL package was found.
- `npm install` resolved 34 packages and reported one audit advisory; no audit fix was run.

## Network calls and offline PMTiles routing

The upstream page requests:

- `https://unpkg.com/maplibre-gl@5.13.0/dist/maplibre-gl.css`
- `https://unpkg.com/maplibre-gl@5.13.0/dist/maplibre-gl.js`
- `https://unpkg.com/pmtiles@4.5.0/dist/pmtiles.js`
- `https://pmtiles.io/protomaps(vector)ODbL_firenze.pmtiles` through PMTiles' `FetchSource`.

The first three are routed to `dist/vendor/`. The PMTiles route must honor the browser's `Range: bytes=start-end`
header and return `206`, `Content-Range`, `Accept-Ranges: bytes`, and the requested byte slice. The committed archive
is generated from invented vector data as documented in [`sources/pmtiles.md`](../../fixtures/sources/pmtiles.md);
do not copy the upstream ODbL Firenze archive or any other sample archive whose data license is outside geowright's
allowed set.
