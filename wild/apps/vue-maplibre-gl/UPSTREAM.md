# Upstream: indoorequal/vue-maplibre-gl

- Repo: https://github.com/indoorequal/vue-maplibre-gl
- Commit vendored from: `2d8cb4de10ae686d48ed597eec3b995f1c8b175b`
- License: MIT ("Copyright 2021 Volker Nauruhn, 2024 François de Metz"). Kept verbatim at
  [`LICENSE`](./LICENSE) (copied unmodified from the repo root).
- The published package is installed from npm (`@indoorequal/vue-maplibre-gl@^9.0.1`), not built
  from the clone — the clone was only used to read source (`lib/`), docs, and the three examples.
- Vendored from: `docs/examples/{filter,geojson,marker-popup}.vue`.
- Date vendored: 2026-09-20.

## Vendored paths

```
wild/apps/vue-maplibre-gl/LICENSE                      <- LICENSE
wild/apps/vue-maplibre-gl/examples/filter.vue           <- docs/examples/filter.vue (+1 line, see below)
wild/apps/vue-maplibre-gl/examples/geojson.vue          <- docs/examples/geojson.vue (+1 line, see below)
wild/apps/vue-maplibre-gl/examples/marker-popup.vue     <- docs/examples/marker-popup.vue (+1 line, see below)
```

All three files are byte-identical to upstream except for the one added `@map:load` attribute on
their `<mgl-map>` element (verified with `diff -u` against the upstream clone — shown below).

Everything else in this directory (`package.json`, `vite.config.js`, `filter/`, `geojson/`,
`marker-popup/` top-level dirs, this file) is **ours**, not upstream — see "Our build boilerplate"
below.

## The one-line change (per example)

Each `<example>.vue`'s `<mgl-map>` element gets one added attribute:

```
@map:load="e => ((e.map.getContainer().ownerDocument.defaultView.__geowright_maps ??= {}).main = e.map)"
```

This is semantically the standard `wild/` hook
(`(window.__geowright_maps ??= {}).main = map;`, see `wild/README.md`) but reaches `window`
through `e.map.getContainer().ownerDocument.defaultView` instead of the bare identifier `window`.
See "Findings worth recording" below for why the bare identifier does not work here — this is not
a stylistic choice, it is the only form of the one-line hook that actually runs.

`@map:load` is vue-maplibre-gl's own re-emission of MapLibre's native `load` event (see
`MAP_EVENT_TYPES` in `lib/components/map.component.ts`, and `lib/lib/map.lib.ts`, which emits
`map:<eventName>` for every event in that list with payload `{ type, map, component, event }`).
This is confirmed by the clone's own `docs/examples/playground.vue`, which already uses
`@map:load="onLoad"`. None of the three examples already had a `@map:load` handler, so nothing
was overwritten.

### `examples/filter.vue`

```diff
--- a/docs/examples/filter.vue
+++ b/wild/apps/vue-maplibre-gl/examples/filter.vue
@@ -7,6 +7,7 @@
     :center="center"
     :zoom="zoom"
     height="500px"
+    @map:load="e => ((e.map.getContainer().ownerDocument.defaultView.__geowright_maps ??= {}).main = e.map)"
   >
     <mgl-geo-json-source source-id="earthquakes" :data="earthquakesUrl">
       <mgl-circle-layer layer-id="eathquakes" :paint="paint" :filter="filter" />
```

### `examples/geojson.vue`

```diff
--- a/docs/examples/geojson.vue
+++ b/wild/apps/vue-maplibre-gl/examples/geojson.vue
@@ -7,6 +7,7 @@
     :center="center"
     :zoom="zoom"
     height="500px"
+    @map:load="e => ((e.map.getContainer().ownerDocument.defaultView.__geowright_maps ??= {}).main = e.map)"
   >
     <mgl-geo-json-source
       source-id="geojson"
```

### `examples/marker-popup.vue`

```diff
--- a/docs/examples/marker-popup.vue
+++ b/wild/apps/vue-maplibre-gl/examples/marker-popup.vue
@@ -7,6 +7,7 @@
     :center="center"
     :zoom="zoom"
     height="500px"
+    @map:load="e => ((e.map.getContainer().ownerDocument.defaultView.__geowright_maps ??= {}).main = e.map)"
   >
     <mgl-navigation-control />
     <mgl-marker :coordinates="coordinates">
```

`filter.vue`'s `layer-id="eathquakes"` (missing the "r") is upstream's own typo — vendored
unchanged, not fixed.

## Our build boilerplate (not upstream)

- `wild/apps/vue-maplibre-gl/package.json` — private, `"name": "geowright-wild-vue-maplibre-gl"`.
  `dependencies`: `@indoorequal/vue-maplibre-gl ^9.0.1`, `maplibre-gl ^6.0.0`, `vue ^3.4.18` — the
  exact ranges the library's own `package.json` declares as its `version`/`peerDependencies`.
  `devDependencies`: `vite ^8.2.0`, `@vitejs/plugin-vue ^6.0.0`, `sass ^1.104.1`.
- `wild/apps/vue-maplibre-gl/vite.config.js` — multi-page build, `root` = this directory,
  `base: './'`, three inputs (`filter/index.html`, `geojson/index.html`,
  `marker-popup/index.html`), `build.outDir: 'dist'`, `build.sourcemap: false`,
  `build.emptyOutDir: true`, `plugins: [vue()]`.
- `wild/apps/vue-maplibre-gl/{filter,geojson,marker-popup}/index.html` + `main.js` — ours. Each
  `index.html` gives `#app` (and `html,body`) full-viewport sizing via an inline `<style>`; the
  vendored `<mgl-map>` itself hardcodes `height="500px"` as a component prop (unchanged, part of
  the vendored file), so the map renders 500px tall inside the full-viewport page — expected, not
  a bug. Each `main.js` calls `setWorkerUrl()` before mounting (see "worker" finding below), then
  `createApp(Example).mount('#app')`.
- This file (`UPSTREAM.md`).

Installed versions actually resolved by `npm install` (all within the declared ranges):
`@indoorequal/vue-maplibre-gl@9.0.1`, `maplibre-gl@6.10.0`, `vue@3.5.43`, `@vitejs/plugin-vue@6.0.9`,
`sass@1.104.1`, `vite@8.3.0`.

## Build command

```
cd wild/apps/vue-maplibre-gl && npm install && npm run build
```

`npm run build` runs `vite build`. `dist/` is committed (see the root `.gitignore` exception) so
tests never need a second `npm install`/build. `build.license` makes Vite write `dist/THIRD_PARTY_LICENSES.md`: the license text of every npm package the build bundles
(`node wild/scripts/apps.mjs check` fails without it).

## Findings worth recording

### The bare `window` identifier does not work inside a `<script setup>` template expression — fixed via `e.map.getContainer().ownerDocument.defaultView`

The hook this task specified verbatim was:

```
@map:load="e => ((window.__geowright_maps ??= {}).main = e.map)"
```

Built and run against a real page (Playwright, `http://localhost:4174/apps/vue-maplibre-gl/filter/`),
this throws at runtime:

```
TypeError: Cannot read properties of undefined (reading '__geowright_maps')
    at g.onMap:load.r.<computed> (.../assets/filter-Ch16FUwr.js:1:558)
```

Root cause, read directly from the installed compiler
(`wild/apps/vue-maplibre-gl/node_modules/@vue/shared/dist/shared.cjs.js:209`): Vue's SFC compiler,
when compiling a `<script setup>` component's `<template>` (as `@vitejs/plugin-vue` always does,
in "inline"/module mode — not the legacy `with(this){...}` runtime-compiled path), rewrites every
free identifier in a template expression to `_ctx.<name>` **unless** it's a recognized setup
binding or is in a small hardcoded global whitelist:

```
Infinity,undefined,NaN,isFinite,isNaN,parseFloat,parseInt,decodeURI,decodeURIComponent,encodeURI,
encodeURIComponent,Math,Number,Date,Array,Object,Boolean,String,RegExp,Map,Set,JSON,Intl,BigInt,
console,Error,Symbol
```

`window` (and `globalThis`, `self`, `document`) are not on that list, so `window.__geowright_maps`
compiles to `_ctx.window.__geowright_maps`. The rendered component instance has no `window`
property, so `_ctx.window` is `undefined`, and the member access throws — confirmed by the exact
error text above, and by grepping the built `dist/assets/*.js` for the literal compiled output
(`(n.window.__geowright_maps??={}).main=e.map`, where `n` is the minified `_ctx`).

Fix used, still exactly one added template attribute, no `<script setup>` change: reach the real
`window` through the MapLibre `Map` instance itself, which is already in scope as the local lambda
parameter `e` (not a free/global identifier, so it is never ctx-prefixed):

```
@map:load="e => ((e.map.getContainer().ownerDocument.defaultView.__geowright_maps ??= {}).main = e.map)"
```

`Map.getContainer()` is documented public API (confirmed in
`node_modules/maplibre-gl/dist/maplibre-gl.d.ts`, `getContainer(): HTMLElement`); a DOM element's
`ownerDocument.defaultView` is the same `window` singleton as the page's global `window` for a
non-iframed top-level document, which is exactly this setup. Rebuilt and re-verified with the same
Playwright smoke test: `hookSet: true` on all three examples, no ctx/undefined errors. See the
"Smoke test" results below.

### The MapLibre GL JS 6 worker: `setWorkerUrl()` IS needed, and this was verified, not assumed

Unlike `wild/apps/react-map-gl`'s examples (which ship the worker fix as part of the vendored
`index.html` itself), `indoorequal/vue-maplibre-gl`'s `lib/` has no `setWorkerUrl`/worker handling
at all (grepped, nothing found) — the app embedding the library is responsible for it, same as
`demo/src/main.ts` in this repo. So each of our (not vendored) `<example>/main.js` does:

```js
import { setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
setWorkerUrl(workerUrl);
```

This was verified necessary by actually removing it (temporarily, from `filter/main.js` only) and
rebuilding: the built `vue-maplibre-gl.es-*.js` chunk's internal fallback (minified name `jj`, at
the point it's used: `let e=vl.WORKER_URL||jj()`) computes

```js
function jj(){
  let e = import.meta.url; // the chunk's OWN url, e.g. .../assets/vue-maplibre-gl.es-<hash>.js
  ...
  return new URL('./maplibre-gl-worker.mjs', e).href; // unhashed .mjs, next to that chunk
}
```

i.e. without `setWorkerUrl()`, MapLibre looks for an **unhashed** `maplibre-gl-worker.mjs` next to
the bundled library chunk in `dist/assets/`. Vite's `?worker&url` transform instead emits a
**hashed** `.js` file (`dist/assets/maplibre-gl-worker-CNLXcz58.js` in this build) — no unhashed
`.mjs` file exists anywhere in `dist/`, so the fallback path would 404 at runtime and the map would
never get a worker. The change was reverted after confirming this (the shipped `dist/` has
`setWorkerUrl()` in all three `main.js` files, and the built hash `maplibre-gl-worker-CNLXcz58.js`
is unchanged from before the experiment, so the real build was not left in the modified state).

### `sass` devDependency: required by the vendored `<style lang="scss">` block

Each of the three vendored `.vue` files ends with (unedited, part of the upstream file):

```html
<style lang="scss">
@import "maplibre-gl/dist/maplibre-gl.css";
</style>
```

This is upstream's own documented way to import MapLibre's CSS from a single-file component (see
the clone's `docs/guide/getting-started.md`, "Single-File-Components" section). Because of
`lang="scss"`, Vite/Vue's SFC style-block compiler needs an installed Sass compiler even though the
block's content is a trivial `@import` — without `sass` as a devDependency, `vite build` fails
trying to load the SCSS preprocessor. Added proactively (not discovered via a failed build) because
this was flagged ahead of time as a known one-retry risk.

### `@vitejs/plugin-vue` version had to be bumped from the task's suggested `^5.0.0`

`@vitejs/plugin-vue@5.x`'s peer dependency is `vite: ^5.0.0 || ^6.0.0`, which conflicts with the
installed `vite@^8.2.0` (resolves to `8.3.0`) and fails `npm install` with `ERESOLVE`.
`@vitejs/plugin-vue@6.x`'s peer dependency is `vite: ^5.0.0 || ^6.0.0 || ^7.0.0 || ^8.0.0`, which
is compatible. This was the one build-cycle retry allotted for install/build failures; install
succeeded on the second attempt with `@vitejs/plugin-vue ^6.0.0`.

## Smoke test

Verified by actually running a throwaway Playwright script (not assumed) — see the final report
for full per-example results (hook set, `loaded()`, console errors, external URLs, layer ids).
