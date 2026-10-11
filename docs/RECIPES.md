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
the hook in the form that wrapper needs. It warns when the `maplibre-gl` or `mapbox-gl` range there is not one geowright
is tested with (MapLibre GL JS 2–6, Mapbox GL JS 1.13), or has no version to tell by (`latest`). It never overwrites a file
without `--force`. Where the project has no `playwright.config.*` it writes a complete one (flags wired in, `baseURL`,
`webServer`) with two lines marked CHECK: where your app is served and how it is started. An existing config is never
edited, not even with `--force`: `init` prints what to add to it, or says that it launches with the flags already (a
second run of `init`, or a config they were pasted into; the import alone does not count; every Chromium project must have the flags in its effective launchOptions). Where the config has `projects` (`npm init playwright` writes chromium,
firefox and webkit), that is the import and `launchOptions: { args: WEBGL_SOFTWARE_FLAGS }` in the `use` of each Chromium
project: a second `projects` key would replace the ones there. Where a `use` has `launchOptions` already, the flags go
into it (`...WEBGL_SOFTWARE_FLAGS` in its `args`): a second `launchOptions` would replace it, and a project's own replaces
the config's whole, so a config without `projects` whose `use` has `launchOptions` gets the flags there. Without `--dir`,
the files go where that config's projects look for tests, read as Playwright reads them: a project's own `testDir` and
`testMatch`, else the config's (a setup project that takes only `*.setup.ts` does not count). `init` warns when no
project would find `map.spec.ts` (step 3 would say "No tests found"), and adds a note where it cannot read the config
well enough to tell: a `testDir` from a variable or an escaped string literal, or a config that spreads another (`{ ...base }`,
`defineConfig(base, { … })`). The fixture opens `--url` (default `/`) relative to the config's `use.baseURL`: a config without
one (Playwright leaves it unset by default) needs it set and the app served, or a full URL
(`--url http://localhost:5173/`).

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

Re-pointing an image (`updateImage`), vector tiles (`setTiles`), or GeoJSON URL (`setData`) faster than loads finish
also counts as never idle when overlapping starts keep occurring through the wait (for example, every 200 ms with
400 ms loads). `.not` and counts can pass from the current map while the newest data is still loading.
One load, two replacements, or sequential completed loads still wait for the data; another pending source also
prevents a never-idle verdict.

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
boundary offline. An interleaved deck.gl layer drawn above a MapLibre feature is a custom layer, which the hit test cannot
see: an action on the feature there probes its pixels, and fails `occluded` naming the custom layer if deck.gl's drawing
hides it ([A raster or image layer is drawn over my features](#a-raster-or-image-layer-is-drawn-over-my-features)).

## Labels of the basemap cover my features

If your layers are inserted below the basemap's labels (the usual advice), labels ARE on top of them. geowright then
picks another pixel of the feature that is not under a label; if there is none it fails with `occluded`, naming the label
layer. To say "labels do not count": `geowright(page, { ignoreLayers: [/* label layer ids */] })`, or per action.

## A raster or image layer is drawn over my features

The map's hit test returns features only (a heatmap on MapLibre >= 5 comes back over its whole radius, but its hit does
not count as cover), so for a raster, image, video, canvas, heatmap, hillshade, color-relief, background or custom layer
drawn ABOVE a feature an action looks at pixels: it probes the feature's own layer at the pixel it is about to press, and if
hiding that layer changes nothing there, the pixel is covered. An opaque veil or overlay then fails the action with
`occluded`, naming the layer. A translucent layer (a radar), or a transparent gap in an opaque one, lets it through,
unless the feature itself draws nothing at that pixel: a ring marker with a transparent fill, or a polygon drawn only
by its outline, is probed in its empty middle and reads as covered even under a translucent layer (README, Limits).
`ignoreLayers` below lets such an action through.

If your overlay is see-through where it matters and you do not want to pay for the probe, say so:

```ts
// the app draws a translucent radar layer over its alerts
await map.feature({ layer: 'alerts', id: 1 }).click({ ignoreLayers: ['radar'] });
```

or for every action of that handle: `geowright(page, { ignoreLayers: ['radar'] })`.

What it costs and what it does not see: a probe is four renders (measured medians: 15–45 ms across
the tested versions; actual cost varies with rendering conditions)
and runs only when such a layer is drawn above the target at that pixel; where the target's opacity is data-driven the
probe reloads its source, and the action waits for it (and there an overlay that changes colour by itself can still,
rarely, pass for the target showing through). Each action probes anew; only its own retries reuse a verdict.
`moving: 'allow'` is not checked. Pixels that change inside an overlay that was already there between the last probe and
the press (the next radar frame filling a gap) are not re-checked; an overlay that appears in that time is. Where the
probe reloads the target's source, that time includes the reload; an overlay given new data during the first one is
probed once more, and the action goes ahead only if it still sees the target. The snapshot
does not probe: a feature under such a layer is listed with `under-pixel-layer:<ids>`.

## An offline basemap

Tests should not depend on a tile server. `routeVectorTiles(page, '**/tiles/**', { <source-layer>: <GeoJSON> })` cuts real
vector tiles from GeoJSON inside `page.route` (give the source a `maxzoom`, 14 like the helper's default, or every zoom
level past it is requested and cut separately). In a repository checkout,
[`tests/wild/basemap.ts`](../tests/wild/basemap.ts) builds a whole OpenMapTiles-shaped basemap that way
(style, sprite with road shields, glyphs, a synthetic city and region with production-like label density;
`{ dense: false }` for the old sparse city). This test helper is not in the installed package. Also from
a repository checkout, `bash scripts/fetch-real-basemap.sh` and then
`GEOWRIGHT_REAL_BASEMAP=1 npx playwright test tests/wild/real-basemap.spec.ts` exercise a real basemap
locally (ODbL data cached outside the repository, never committed or fetched by CI). These scripts
and specs are not in the installed package.

For a `pmtiles://https://…` source, route the underlying HTTPS archive URL and serve a local synthetic archive with
HTTP byte ranges (`206`, `Content-Range`, `Accept-Ranges`). The [Protomaps wild spec](../tests/wild/pmtiles.spec.ts) is
a working example; its upstream Firenze archive is ODbL-derived and is never fetched by tests.

## Slow pages (terrain, a globe, software GL in CI)

`test.slow()` — geowright's default timeouts follow the test's timeout: a third of it for actions (at least 10 s), two
thirds for `waitForIdle()` (the first idle is a page load, not an action). Assertions (`expect(map)…`) use Playwright's
expect timeout, which `test.slow()` does not change: raise it in the config (`expect: { timeout: 15_000 }`) or per
assertion (`{ timeout }`). An action's `timeout` is wall-clock until its input is sent, also on a page too busy to answer.
Real input is never abandoned half-way, and a feature's `click()` / `tap()` then wait for the page to say where it
landed. As in Playwright, `timeout: 0` means no timeout.

## Old versions

MapLibre GL JS 2–6 and Mapbox GL JS 1.13 are tested (`npm run test:compat`; README, "Supported map library versions").
What a version cannot do is said in failure messages and in the snapshot (`note: …`), not guessed.
