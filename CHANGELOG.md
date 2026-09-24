# Changelog

Not published; versions start when the package does. Until then this lists what changed, newest first
(details and reasoning: `docs/DESIGN.md`). Breaking changes are marked **BREAKING**.

## Unreleased — publishable and broad
- **`geowright/app`: the hook's type, for the app's TypeScript.** `/// <reference types="geowright/app" />` in a `.d.ts`
  the app's tsconfig includes declares `window.__geowright_maps?: Record<string, unknown>`, so
  `(window.__geowright_maps ??= {}).main = map` compiles without `(window as any)`. Types only: the export has no
  JavaScript, nothing is imported at run time, the hook line is unchanged
  ([0002](docs/decisions/0002-the-app-hook-contract.md)). `npx geowright init` prints the reference line in a
  TypeScript project; it never edits the app's files or its tsconfig. The main `'geowright'` entry does not declare it.
- **Failures explain invisibility.** When the style hides a matching feature, the failure message ("What is on the map")
  names the style property, its value, the expression branch that produced it and the zoom:
  `-> why#1 is not visible at zoom 12: fill-opacity is 0 because the match on ["get","kind"] took its fallback for kind="park"`.
  Traced: `match`, `case`, `step`, `interpolate` (-hcl, -lab), `coalesce`, nested, and legacy `{ stops }` functions;
  anything else (`let`/`var`, arithmetic, an interpolation between two stops) is named by property and value only. A
  layer the style does not draw says so: `layer "x" is not drawn at zoom 12: its minzoom is 13`, or its maxzoom, or
  `visibility` "none" — a constant or an expression on global state. Branches come from MapLibre's own evaluator; the
  verdict itself is unchanged. Adapter seam: optional `explainInvisible()` / `explainLayerHidden()`, plain `StyleCause`
  data — internal until 1.0, so not in the published typings (`src/inpage/types-internal.ts`).
- **Fixed:** a layer hidden by a `visibility` EXPRESSION (MapLibre >= 5.16, e.g. on global state) counted as visible in
  `map.layers()` and the snapshot ("visible but empty in this view", not under "hidden layers"). The layer list now
  evaluates the expression, as the failure messages above do.
- **Fixed:** `snapshot()` on a production-sized basemap (80–120 layers) listed none of the app's own entities: every
  basemap layer kept its section and every layer id stayed in the header, which alone filled the 8000-character budget
  (the real OpenFreeMap style: 0 of 1,025 3D buildings listed; now 15). Within the budget the basemap is now condensed
  first, in stages: no rows; one shared "how to list a layer" note instead of one per layer; header lists count its
  layers per source (`(38 basemap layers on openmaptiles)`); a count line per layer; one line per source naming its
  layers with counts (`[basemap source openmaptiles] 1425 entities on 27 layers, none listed — symbol: label_town 6,
  …`); that line counting layers by type. Only then do the app's rows shrink. App layer lines are unchanged. A layer
  the app adds to the basemap's source counts as the app's when it is the only one of its type there (the 3D-buildings
  example); layers named in `layers` never count as basemap.
- **Fixed:** the pixel probe (`toBeVisibleOnMap`, `toHaveLayerPixels`) wrote back `visibility: "visible"` after hiding
  the layer, replacing a `visibility` EXPRESSION (MapLibre >= 5.16) — and turning on a layer the app had hidden. It now
  restores what was there.
- **Docs you can trust:** every TypeScript / JavaScript example in `README.md` and `docs/RECIPES.md` is type-checked
  against the API and run against the demo app by the normal suite (`tests/docs/`); a block that cannot run says why
  in the Markdown (`<!-- example: skip (reason) -->`). The README examples that did not run as written (undefined
  variables, steps in an order the map could not be in, query objects that were not code) now do.
- **Peer dependency**: `@playwright/test` `>=1.49.0` (was `>=1.50.0`, never tested): a CI job (`playwright-floor`)
  runs typecheck and the full suite on exactly the version the range names
  ([0014](docs/decisions/0014-claim-only-what-is-tested.md)). Below 1.49 the suite's `toMatchAriaSnapshot` is missing,
  and below 1.45 so is `this.timeout` in custom matchers, which geowright's matchers use.
- **Version matrix**: Mapbox GL JS 1.13 (BSD) and MapLibre GL JS 2, 3, 4, 5, 6 — `npm run test:compat`, support table
  in the README. Adapter: `getLayersOrder` / `GeoJSONSource.getData` / `areTilesLoaded` / `getRenderWorldCopies` are
  feature-detected with public fallbacks; `mapboxgl-` marker/popup classes; the pixel probe works without `redraw()`
  (through the `render` event; seam: `pixelContribution` may return a promise); new caveats say what a version cannot do.
- **`npx geowright init`** (fixture, WebGL flags, first spec, the hook for the detected wrapper; a complete
  `playwright.config` where the project has none — an existing one is never edited) and `docs/RECIPES.md`.
- **`{ moving: 'allow' }`** on `click` / `dblclick` / `rightClick` / `tap` / `hover`: act on a feature that never stops
  moving. Skips the at-rest and two-frame checks, aims ahead along the measured velocity (lead learnt from misses), and
  relies on the click-time verification: late input is swallowed and retried, never delivered to something else.
- **Fixed (precision):** action points and snapshot pixels are WHOLE client pixels, verified as such. Real input arrives
  with fractional coordinates, but map libraries handle `click` / `mousedown` MouseEvents, which the browser truncates;
  a pixel verified at 339.6 was not the pixel MapLibre hit-tested at 339 (found under dense basemap labels: we said
  "building on top", MapLibre said "label on top"). For shapes thinner than a pixel the four whole pixels around a
  candidate are tried too.
- `waitForIdle()` defaults to two thirds of the test timeout (it is a load, not an action): 20 s instead of 10 s.
- The default action timeout scales with the test's timeout (`test.slow()`, `test.setTimeout()`); an action's `timeout` is
  wall-clock (side-effect-free round trips are abandoned at the deadline; real input never is).
- `waitForIdle()` on a map that never idles says why: an animated canvas / video source, a GeoJSON source re-set in a
  loop, continuous repainting, tiles still loading, or a moving camera — and, when inline GeoJSON has not loaded for
  seconds while no GeoJSON / vector source has loaded at all, that MapLibre's web worker is almost certainly dead.
- Snapshot: basemap layers (a tiled source with 8+ layers) give up their rows before the app's layers do.
- A feature with only a sliver inside the viewport is reported `offscreen` with that explanation, not `not-found`.
- **Fixed:** a GeoJSON source holding a bare geometry (`{ type: 'Point', … }`, no Feature wrapper) was read as having no
  features, which disabled off-screen diagnostics, `autoPan: true`, full geometries and identity learning for it.
- **Fixed:** `toBeVisibleOnMap()` could pass without having probed a pixel when the probe threw. `{ pixels: true }` now
  fails, saying so, on a map that cannot be probed at all.
- Licensed under **Apache-2.0**: `LICENSE`, `NOTICE`; the package ships `dist/THIRD_PARTY_LICENSES.txt`
  (license texts of what is bundled into the injected scripts, generated from the bundler's input list).

## Unreleased — apps we did not write
- `wild/` suite: MapLibre's own examples and real open-source apps, vendored with a one-line hook.
- fill-extrusion features are acted on where they are DRAWN (roof, walls), not only on their footprint.
- Polygon action points are ranked across all parts/tile pieces; grid density follows on-screen size;
  the search is bounded (600 hit tests) — a mostly-covered feature is reported `occluded`.
- **BREAKING** `feature.lngLat()` returns the VERIFIED action point (waits and fails like `click()`);
  `info().lngLat` stays the cheap geometric candidate.
- `FeatureSummary.state` (MapLibre feature-state).
- Snapshot: evaluated colour per feature / per layer, `state=`, `projection` / `terrain on`,
  pixel-only layers (raster, hillshade, heatmap) no longer called "empty", tiled-source note per source.
- Unsupported style expressions are reported once (`note: visibility unknown for layer …`) instead of
  silently counting as visible.
- `vectorTileHandler()` exported from `geowright/tiles`.
- Features with no id and identical properties are separate features (split by where they are drawn; world
  copies folded). Before: merged into one.
- Globe projection: viewport-wide queries are answered by a grid of box queries + near-side check, and
  fill-extrusions by a point sweep — works around MapLibre 6.10 returning a fraction of what is visible.
- Queries: `layerType`, `source` (for wrapper-generated layer ids).
- Actions scroll the map into the browser viewport first; a part of the map outside the window is reported.
- Drags (`dragAt`, `dragTo`, `dragBy`) honour `modifiers` (they were silently dropped).
- An invisible feature on top is not an occluder. `map.marker()` / `map.popup()` Locators are pinned to their
  element (custom selector engine) instead of `css >> nth(i)`.
- New: `expect(map).toHaveLayerPixels()`, `map.touchDragAt()`, `map.doubleTapAt()`, `viewState().projection` /
  `.terrain`; failure text names a missing icon image; `toHaveGeometry` validates vertex lists.

## Unreleased — visibility, dense maps, drawing, touch
- **BREAKING** queries match VISIBLE features by default (`visible: 'any'` opts out).
- Visibility (paint evaluation + pixel probe), dense-map candidates, drawing helpers, `toHaveGeometry`,
  globe far-side fix, markers / popups, failure screenshots, touch + keyboard, unit tests, Linux CI.

## Unreleased — the core
- Adapter seam, engine, MapLibre adapter, retrying matchers, actionability, click-time verification,
  text snapshot + accessibility mirror for agents, vector tiles from GeoJSON, packaging.
