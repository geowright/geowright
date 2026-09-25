# Recipes

Short answers to "how do I…", each taken from an app in [`wild/`](../wild/README.md) that somebody else wrote.
The reasoning behind them is in [DESIGN.md](DESIGN.md).

## Start: `npx geowright init`

```sh
npm i -D geowright @playwright/test && npx playwright install chromium
npx geowright init            # [--dir tests] [--url /] [--force]
```

Writes `geowright.fixture.ts` (a `map` fixture), `geowright.webgl.ts` (the software-WebGL launch flags) and `map.spec.ts`
(a first spec that prints `map.snapshot()` — read it once: it tells you your layer ids and property names). It looks at
your `package.json`, recognises react-map-gl, `@vis.gl/react-maplibre`, svelte-maplibre-gl and vue-maplibre-gl, and prints
the hook in the form that wrapper needs. It never overwrites a file without `--force`. Where the project has no
`playwright.config.*` it writes a complete one (flags wired in, `baseURL`, `webServer`) with two lines marked CHECK: where
your app is served and how it is started. An existing config is never edited, not even with `--force`: `init` prints the
two lines to add to it.

## The one line, per wrapper

Test / development builds only — the line exposes the map instance to every script on the page ([SECURITY.md](../SECURITY.md)).

<!-- example: skip (app-side code: it runs in your app, not in a test; `{ … }` stands for your map options) -->
```ts
// plain MapLibre GL JS / Mapbox GL JS v1
const map = new maplibregl.Map({ … });
if (import.meta.env.MODE !== 'production') (window.__geowright_maps ??= {}).main = map;
```
<!-- example: skip (app-side component markup with elided props; verified in wild/apps/react-map-gl) -->
```jsx
// react-map-gl, @vis.gl/react-maplibre
<Map onLoad={(e) => ((window.__geowright_maps ??= {}).main = e.target)} … />
```
```svelte
<!-- svelte-maplibre-gl -->
<MapLibre onload={(e) => ((window.__geowright_maps ??= {}).main = e.target)} … />
```
```vue
<!-- vue-maplibre-gl: a Vue TEMPLATE cannot see `window` — reach it through the map's own document -->
<mgl-map @map:load="e => ((e.map.getContainer().ownerDocument.defaultView.__geowright_maps ??= {}).main = e.map)" … />
<!-- in <script setup> the plain form works:  const onLoad = (e) => ((window.__geowright_maps ??= {}).main = e.map) -->
```

In TypeScript, add one reference line to a `.d.ts` file that your **app's** tsconfig includes (a Vite app already has
`src/vite-env.d.ts`, with `/// <reference types="vite/client" />` in it):

<!-- example: skip (app-side: a type reference for your app's tsconfig, not test code; compiled by tests/unit/app-type.unit.spec.ts) -->
```ts
/// <reference types="geowright/app" />
```

It declares `window.__geowright_maps` (the maps as `unknown`, so your app's types never depend on a map library's
typings through geowright), and the hook line compiles as written, without `(window as any)`. It is types only:
nothing is imported at run time and nothing ships. It belongs in the app's tsconfig: the tests' `import 'geowright'`
does not declare it.

Two maps on a page: register them under two names and pass `geowright(page, { mapId: 'left' })`.

## "no map registered" although the line is there

Wrappers call `onLoad` on MapLibre's `load` event, and `load` needs **every declared source**. If a data request is
blocked or fails in the test, `load` never fires and the map is never registered. Look at the network, not at the hook:
answer every request the app makes with `page.route` (the [harness](../tests/wild/harness.ts) fails a test listing the
URLs nobody answered — copy that idea).

## The map never becomes idle

An animated source, a `setData` loop, a rotating camera: `waitForIdle()` times out and says which of these it saw. Do
not wait for idle on such a page — assertions and actions retry by themselves. To act on a feature that never stops
moving: `click({ moving: 'allow' })` (README, "What an action waits for"; the reasoning: DESIGN, "Targets that never stop moving").

**A static map that times out with "… DEAD WORKER …"** (or, for sources loaded from a URL, "source(s) … have not
finished loading") is usually not a test problem: the app's map is broken in the browser too. The common case is MapLibre GL JS 6 under Vite's DEV server — the dependency
optimizer moves `maplibre-gl` and its worker file is not found (the dev server's log says `maplibre-gl-worker.mjs …
does not exist … Try adding it to optimizeDeps.exclude`), so no source ever loads. In `vite.config`:
`optimizeDeps: { exclude: ['maplibre-gl'] }`, or test the built app (`vite build && vite preview`), which is what this
repository does. Note also that MapLibre 6 is ESM with named exports only: `import { Map } from 'maplibre-gl'`
(or `import * as maplibregl`), not a default import.

## Layer ids I do not control

svelte-maplibre-gl generates `svmlgl-layer-0…` from a counter that shifts when a layer is added. Address layers by
what they are: `{ layerType: 'circle', source: 'earthquakes' }`, or give your layers explicit ids.

## Features without ids

Identity is id + properties, and id-less features with identical properties are told apart by where they are drawn. To
pick one of several look-alikes, say where: `map.feature({ layer: 'poi', where: { icon: 'music' }, at: { lng, lat } })`.

## A deck.gl overlay on MapLibre

The MapLibre map remains accessible through the usual one-line hook, even when deck.gl interleaves custom layers in
its WebGL canvas. `map.layers()` can show those custom layer IDs, and geowright can act on MapLibre-rendered features
underneath. deck.gl's own scatterplots, arcs, and text are picked by deck.gl, not by MapLibre's `queryRenderedFeatures`,
so they are not addressable with `map.feature()`. The [vendored MapboxOverlay app](../wild/apps/deck-gl/) exercises that
boundary offline.

## Labels of the basemap cover my features

If your layers are inserted below the basemap's labels (the usual advice), labels ARE on top of them. geowright then
picks another pixel of the feature that is not under a label; if there is none it fails with `occluded`, naming the label
layer. To say "labels do not count": `geowright(page, { ignoreLayers: [/* label layer ids */] })`, or per action.

## A raster or image layer is drawn over my features

Occlusion comes from the map's hit test, which returns features only. So an opaque raster, image, video, canvas, heatmap
or hillshade layer drawn ABOVE a feature (a loading veil, an opaque overlay) does not stop `click()` on it: see the
README's Limits. Where your app can have one up, assert that it is not painting where the click will land before you
act:

```ts
const alert = map.feature({ layer: 'alerts', id: 1 });
const at = await alert.lngLat(); // where click() will press: on a line or a polygon, not just any point of it
if ((await map.layers()).some((l) => l.id === 'veil')) {
  await expect(map).not.toHaveLayerPixels('veil', { at }); // hidden, or painting nothing there
}
await alert.click();
```

The layer must exist to be asked about: an app that takes its overlay away with `removeLayer` leaves nothing to probe,
and `toHaveLayerPixels` on a missing layer gives no verdict. Hence the `map.layers()` check. This is a pixel probe: a
few renders, and MapLibre reloads the layer's source after it. Put it where an overlay can be up, not before every
action. It asks about the overlay only: a translucent layer that paints there fails it too, even though the feature
shows through. ([`tests/occlusion-recipe.spec.ts`](../tests/occlusion-recipe.spec.ts) runs it with an overlay up,
hidden and removed.)

## An offline basemap

Tests should not depend on a tile server. `routeVectorTiles(page, '**/tiles/**', { <source-layer>: <GeoJSON> })` cuts real
vector tiles from GeoJSON inside `page.route` (give the source a `maxzoom`, 14 like the helper's default, or every zoom
level past it is requested and cut separately); [`tests/wild/basemap.ts`](../tests/wild/basemap.ts) builds a whole
OpenMapTiles-shaped basemap that way (style, sprite with road shields, glyphs, a synthetic city and region with
production-like label density; `{ dense: false }` for the old sparse city). For a REAL basemap on your own machine only: `scripts/fetch-real-basemap.sh` +
`GEOWRIGHT_REAL_BASEMAP=1` (the data is ODbL: cached outside the repository, never committed).

For a `pmtiles://https://…` source, route the underlying HTTPS archive URL and serve a local synthetic archive with
HTTP byte ranges (`206`, `Content-Range`, `Accept-Ranges`). The [Protomaps wild spec](../tests/wild/pmtiles.spec.ts) is
a working example; its upstream Firenze archive is ODbL-derived and is never fetched by tests.

## Slow pages (terrain, a globe, software GL in CI)

`test.slow()` — geowright's default timeouts follow the test's timeout: a third of it for actions (at least 10 s), two
thirds for `waitForIdle()` (the first idle is a page load, not an action). Assertions (`expect(map)…`) use Playwright's
expect timeout, which `test.slow()` does not change: raise it in the config (`expect: { timeout: 15_000 }`) or per
assertion (`{ timeout }`). An action's `timeout` is wall-clock, also on a page too busy to answer. As in Playwright,
`timeout: 0` means no timeout.

## Old versions

MapLibre GL JS 2–6 and Mapbox GL JS 1.13 are tested (`npm run test:compat`; README, "Supported map library versions").
What a version cannot do is said in failure messages and in the snapshot (`note: …`), not guessed.
