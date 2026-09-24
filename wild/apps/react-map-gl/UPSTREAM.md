# Upstream: visgl/react-map-gl

- Repo: https://github.com/visgl/react-map-gl
- Commit vendored from: `1afe1a98580680c870eeb1139c40a94835333705`
- License: MIT ("Copyright Vis.gl contributors."). Kept verbatim at
  [`LICENSE`](./LICENSE) (copied unmodified from the repo root).
- Vendored from: `examples/maplibre/{controls,geojson,filter}/` and
  `examples/.data/cities.json`.
- Date vendored: 2026-09-20.

## Vendored paths

```
wild/apps/react-map-gl/LICENSE                      <- LICENSE
wild/apps/react-map-gl/.data/cities.json             <- examples/.data/cities.json
wild/apps/react-map-gl/controls/index.html           <- examples/maplibre/controls/index.html
wild/apps/react-map-gl/controls/package.json         <- examples/maplibre/controls/package.json
wild/apps/react-map-gl/controls/README.md            <- examples/maplibre/controls/README.md
wild/apps/react-map-gl/controls/tsconfig.json        <- examples/maplibre/controls/tsconfig.json
wild/apps/react-map-gl/controls/src/app.tsx          <- examples/maplibre/controls/src/app.tsx (+1 line, see below)
wild/apps/react-map-gl/controls/src/control-panel.tsx <- examples/maplibre/controls/src/control-panel.tsx
wild/apps/react-map-gl/controls/src/pin.tsx          <- examples/maplibre/controls/src/pin.tsx
wild/apps/react-map-gl/geojson/index.html            <- examples/maplibre/geojson/index.html
wild/apps/react-map-gl/geojson/package.json          <- examples/maplibre/geojson/package.json
wild/apps/react-map-gl/geojson/README.md             <- examples/maplibre/geojson/README.md
wild/apps/react-map-gl/geojson/tsconfig.json         <- examples/maplibre/geojson/tsconfig.json
wild/apps/react-map-gl/geojson/src/app.tsx           <- examples/maplibre/geojson/src/app.tsx (+1 line, see below)
wild/apps/react-map-gl/geojson/src/control-panel.tsx <- examples/maplibre/geojson/src/control-panel.tsx
wild/apps/react-map-gl/geojson/src/map-style.ts      <- examples/maplibre/geojson/src/map-style.ts
wild/apps/react-map-gl/geojson/src/utils.ts          <- examples/maplibre/geojson/src/utils.ts
wild/apps/react-map-gl/filter/index.html             <- examples/maplibre/filter/index.html
wild/apps/react-map-gl/filter/package.json           <- examples/maplibre/filter/package.json
wild/apps/react-map-gl/filter/README.md              <- examples/maplibre/filter/README.md
wild/apps/react-map-gl/filter/tsconfig.json          <- examples/maplibre/filter/tsconfig.json
wild/apps/react-map-gl/filter/src/app.tsx            <- examples/maplibre/filter/src/app.tsx (+1 line, see below)
wild/apps/react-map-gl/filter/src/control-panel.tsx  <- examples/maplibre/filter/src/control-panel.tsx
wild/apps/react-map-gl/filter/src/map-style.ts       <- examples/maplibre/filter/src/map-style.ts
```

All files above are byte-identical to upstream except the three `src/app.tsx` files, which each
have exactly one added line (verified with `diff -q` against the upstream clone).

Everything else in this directory (`package.json`, `vite.config.js`, this file) is **ours**, not
upstream — see "Our build boilerplate" below.

## The one-line change (per example)

Each `<example>/src/app.tsx` gets one added line on the `<Map ...>` element:

```jsx
onLoad={e => ((window as any).__geowright_maps ??= {}).main = e.target} // geowright: the one-line test hook (the ONLY change to this app)
```

None of the three examples already had an `onLoad` prop, so nothing was overwritten.

### `controls/src/app.tsx`

```diff
--- a/examples/maplibre/controls/src/app.tsx
+++ b/wild/apps/react-map-gl/controls/src/app.tsx
@@ -51,6 +51,7 @@
           pitch: 0
         }}
         mapStyle="https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json"
+        onLoad={e => ((window as any).__geowright_maps ??= {}).main = e.target} // geowright: the one-line test hook (the ONLY change to this app)
       >
         <GeolocateControl position="top-left" />
         <FullscreenControl position="top-left" />
```

### `geojson/src/app.tsx`

```diff
--- a/examples/maplibre/geojson/src/app.tsx
+++ b/wild/apps/react-map-gl/geojson/src/app.tsx
@@ -48,6 +48,7 @@
         mapStyle="https://basemaps.cartocdn.com/gl/positron-gl-style/style.json"
         interactiveLayerIds={['data']}
         onMouseMove={onHover}
+        onLoad={e => ((window as any).__geowright_maps ??= {}).main = e.target} // geowright: the one-line test hook (the ONLY change to this app)
       >
         <Source type="geojson" data={data}>
           <Layer {...dataLayer} />
```

### `filter/src/app.tsx`

```diff
--- a/examples/maplibre/filter/src/app.tsx
+++ b/wild/apps/react-map-gl/filter/src/app.tsx
@@ -36,6 +36,7 @@
         mapStyle="https://basemaps.cartocdn.com/gl/positron-gl-style/style.json"
         onMouseMove={onHover}
         interactiveLayerIds={['counties']}
+        onLoad={e => ((window as any).__geowright_maps ??= {}).main = e.target} // geowright: the one-line test hook (the ONLY change to this app)
       >
         <Source
           type="geojson"
```

## Our build boilerplate (not upstream)

Upstream's individual `<example>/package.json` files exist for reference/provenance only (each
still declares its own `vite build`/`vite --open` scripts against upstream's monorepo tooling,
which is not present here) — the build actually run is ours:

- `wild/apps/react-map-gl/package.json` — private, `"name": "geowright-wild-react-map-gl"`.
  `dependencies` are the union of the three examples' own `dependencies`, at the same version
  ranges they declare: `react ^18.0.0`, `react-dom ^18.0.0`, `react-map-gl ^8.0.0`,
  `maplibre-gl ^6.0.0`, `d3-array ^3.1.1`, `d3-scale ^4.0.2` (the latter two only used by
  `geojson`). `devDependencies`: `vite ^8.2.0` only — `@vitejs/plugin-react` was **not** needed;
  the examples' `tsconfig.json` sets `"jsx": "react"` (classic runtime) and each `app.tsx`
  already does `import * as React from 'react'`, which is exactly what esbuild's default
  (non-plugin) JSX transform in Vite expects.
- `wild/apps/react-map-gl/vite.config.js` — multi-page build, `root` = this directory,
  `base: './'`, three inputs (`controls/index.html`, `geojson/index.html`, `filter/index.html`),
  `build.outDir: 'dist'`, `build.sourcemap: false`, `build.emptyOutDir: true`. It also carries one
  `resolve.alias` entry, explained below.
- This file (`UPSTREAM.md`).

Installed versions actually resolved by `npm install` (all within the declared ranges):
`react@18.3.1`, `react-dom@18.3.1`, `react-map-gl@8.1.3`, `maplibre-gl@6.10.0`,
`d3-array@3.2.4`, `d3-scale@4.0.2`, `vite@8.3.0`.

## Build command

```
cd wild/apps/react-map-gl && npm install && npm run build
```

`npm run build` runs `vite build`. `dist/` is committed (see the root `.gitignore` change) so
tests never need a second `npm install`/build. `build.license` makes Vite write `dist/THIRD_PARTY_LICENSES.md`: the license text of every npm package the build bundles
(`node wild/scripts/apps.mjs check` fails without it).

## Findings worth recording

### The `.data/cities.json` import needed a build-config redirect (not a source edit)

`controls/src/app.tsx` imports `../../../.data/cities.json` unedited. In the upstream tree that's
`examples/maplibre/controls/src/app.tsx` → 3 levels up → `examples/.data/cities.json`. In our flat
`wild/apps/react-map-gl/<example>/src/app.tsx` layout (required so the multi-page `vite.config.js`
inputs can be the plain `controls/index.html` / `geojson/index.html` / `filter/index.html` this
task specified) the same literal specifier is only 2 levels below `wild/apps/react-map-gl/`, so it
would resolve to `wild/apps/.data/cities.json` — outside this vendored app's directory, and outside
the scope this task was restricted to touching.

Fix, entirely in `vite.config.js`, no source edit:

```js
resolve: {
  alias: [{ find: /^\.\.\/\.\.\/\.\.\/\.data\//, replacement: resolve(__dirname, '.data') + '/' }]
}
```

This redirects that one literal relative specifier to `wild/apps/react-map-gl/.data/cities.json`,
which is where the file is vendored. `geojson` and `filter` don't import any local `.data/*` file
(they `fetch()`/pass a URL for their own data at runtime), so this alias only ever matches
`controls`.

### The MapLibre GL JS 6 worker: no config workaround was needed

This repo's own `demo/` needs `demo/scripts/copy-worker.mjs` + `setWorkerUrl()` in
`demo/src/main.ts` because MapLibre 6 is ESM-only and resolves its worker relative to
`import.meta.url`, which a bundled build breaks.

Upstream's own `<example>/index.html` for all three examples already carries the fix, as a normal
part of the example (not something we added):

```js
import {setWorkerUrl} from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
setWorkerUrl(workerUrl);
```

Vite's built-in `?worker&url` import suffix bundles `maplibre-gl-worker.mjs` as its own asset and
returns a URL to it; the built code then does
`new URL('maplibre-gl-worker-<hash>.js', import.meta.url).href`, i.e. resolved relative to the
*worker-importing chunk's own location* in `dist/assets/`, not the page's URL — so it keeps
working regardless of which of the three `dist/<example>/` directories serves the page. No
`vite.config.js` change, `assetsInclude`, or manual copy of `maplibre-gl-worker.mjs` was required.
Confirmed in the built output: `dist/assets/maplibre-gl-worker-CNLXcz58.js` exists and is
referenced by exactly that pattern from `dist/assets/map-*.js` (the shared MapLibre/react-map-gl
chunk).

### `filter`'s smoke-test result depends on the fixture style having a `waterway_label` layer

`filter/src/app.tsx` (unedited, upstream code) adds its two `<Layer>`s with
`beforeId="waterway_label"`, i.e. it expects the real style
(`https://basemaps.cartocdn.com/gl/positron-gl-style/style.json`) to already contain a layer named
`waterway_label`. See "Smoke test" below for what happens when a fixture style lacks that layer.
