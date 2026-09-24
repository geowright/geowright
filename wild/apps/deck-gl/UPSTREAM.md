# Upstream: visgl/deck.gl MapLibre MapboxOverlay example

- Repository: https://github.com/visgl/deck.gl
- Pinned commit: `b28503d8742e3551a37372b9cb911aa1cc9b6706` (`master`, fetched 2026-09-21)
- License: MIT. The upstream root `LICENSE` is retained verbatim as [`LICENSE`](./LICENSE).
- Upstream app: `test/apps/mapbox-integration/mapbox-overlay-react/`
- Upstream shared module: `test/apps/mapbox-integration/layers.js`

## Vendored paths

```
wild/apps/deck-gl/mapbox-overlay-react/mapbox-overlay-react.jsx <- upstream mapbox-overlay-react/mapbox-overlay-react.jsx (+1 line)
wild/apps/deck-gl/layers.js                                  <- upstream mapbox-integration/layers.js (byte-identical)
wild/apps/deck-gl/LICENSE                                    <- upstream root LICENSE (byte-identical)
```

The upstream React example is preserved byte-for-byte except for the one geowright hook line below. The root
`index.html`, `vite.config.js`, `package.json`, `package-lock.json`, `dist/`, and this file are geowright build
boilerplate or generated output.

## The one-line change

Inside the existing upstream `onMapLoad` callback, immediately after the existing `const map` line:

```diff
 const map = mapRef.current.getMap();
+((window.__geowright_maps ??= {}).main = map);
```

The line registers the underlying MapLibre map after the upstream app's existing `onLoad` event fires. No other
upstream source line is changed.

## Build

From this directory:

```sh
npm install
npm run build
```

The build uses the app-local Vite config and writes the single-page static output to `dist/`. It does not run the
application or Playwright. `build.license` makes Vite write `dist/THIRD_PARTY_LICENSES.md`: the license text of every npm package the build bundles
(`node wild/scripts/apps.mjs check` fails without it). A small plugin in `vite.config.js` corrects one heading
in it: maplibre-gl 3's `dist/package.json` is a stub, so Vite would label it `maplibre-gl - 0.0.0`.

## Dependencies

The dependency versions follow the pinned upstream test app: `@deck.gl/core`, `@deck.gl/layers`,
`@deck.gl/mapbox` 8.9; `maplibre-gl` 3; React and React DOM 18; `react-map-gl` 7.1; Vite 7.3.1. The explicit
`@deck.gl/*` entries support the unmodified upstream imports from `@deck.gl/core`, `@deck.gl/layers`, and
`@deck.gl/mapbox`. The upstream `deck.gl` umbrella import names three layer classes that `@deck.gl/layers`
also exports; the build config aliases only that import. This avoids bundling/installing the unrelated
`@deck.gl/carto` → `cartocolor` → ColorBrewer chain, whose extra license terms are outside this repo's
permissive-only rule. The upstream source line remains unchanged.

## Network calls in the upstream source

- `https://basemaps.cartocdn.com/gl/positron-gl-style/style.json` — MapLibre style and its dependent Carto tile,
  sprite, and glyph requests. Geowright tests must route these requests to approved local fixtures/synthetic
  basemap data.
- `https://raw.githubusercontent.com/visgl/deck.gl-data/master/examples/trips/pois.json` — the deck.gl POI
  `ScatterplotLayer` data. It is not vendored here; tests should route it to a local fixture or replace it in a
  test-only route response.

The source intentionally keeps the upstream URLs. No third-party data or tiles are added to this directory.
