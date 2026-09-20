# Changelog

Not published; versions start when the package does. Until then this lists what changed per phase
(details and reasoning: `docs/DESIGN.md`). Breaking changes are marked **BREAKING**.

## Unreleased — an earlier phase (2026-09-20): publishable and broad
- **Version matrix**: Mapbox GL JS 1.13 (BSD) and MapLibre GL JS 2, 3, 4, 5, 6 — `npm run test:compat`, support table
  in the README. Adapter: `getLayersOrder` / `GeoJSONSource.getData` / `areTilesLoaded` / `getRenderWorldCopies` are
  feature-detected with public fallbacks; `mapboxgl-` marker/popup classes; the pixel probe works without `redraw()`
  (through the `render` event; seam: `pixelContribution` may return a promise); new caveats say what a version cannot do.
- **`npx geowright init`** (fixture, WebGL flags, first spec, the hook for the detected wrapper) and `docs/RECIPES.md`.
- **`{ moving: 'allow' }`** on `click` / `dblclick` / `rightClick` / `tap` / `hover`: act on a feature that never stops
  moving. Skips the at-rest and two-frame checks, aims ahead along the measured velocity (lead learnt from misses), and
  relies on the click-time verification: late input is swallowed and retried, never delivered to something else.
- **Fixed (precision):** action points and snapshot pixels are WHOLE client pixels, verified as such. Real input arrives
  with fractional coordinates, but map libraries handle `click` / `mousedown` MouseEvents, which the browser truncates;
  a pixel verified at 339.6 was not the pixel MapLibre hit-tested at 339 (found under dense basemap labels: we said
  "building on top", MapLibre said "label on top"). For shapes thinner than a pixel the four whole pixels around a
  candidate are tried too.
- The default action timeout scales with the test's timeout (`test.slow()`, `test.setTimeout()`); an action's `timeout` is
  wall-clock (side-effect-free round trips are abandoned at the deadline; real input never is).
- `waitForIdle()` on a map that never idles says why: an animated canvas / video source, a GeoJSON source re-set in a
  loop, continuous repainting, tiles still loading, or a moving camera.
- Snapshot: basemap layers (a tiled source with 8+ layers) give up their rows before the app's layers do.
- A feature with only a sliver inside the viewport is reported `offscreen` with that explanation, not `not-found`.
- **Fixed:** a GeoJSON source holding a bare geometry (`{ type: 'Point', … }`, no Feature wrapper) was read as having no
  features, which disabled off-screen diagnostics, `autoPan: true`, full geometries and identity learning for it.
- **Fixed:** `toBeVisibleOnMap()` could pass without having probed a pixel when the probe threw. `{ pixels: true }` now
  fails, saying so, on a map that cannot be probed at all.
- Licensed under **Apache-2.0**: `LICENSE`, `NOTICE`; the package ships `dist/THIRD_PARTY_LICENSES.txt`
  (license texts of what is bundled into the injected scripts, generated from the bundler's input list).

## Unreleased — an earlier phase (2026-09-20): apps we did not write
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

## an earlier phase (2026-09-20)
- **BREAKING** queries match VISIBLE features by default (`visible: 'any'` opts out).
- Visibility (paint evaluation + pixel probe), dense-map candidates, drawing helpers, `toHaveGeometry`,
  globe far-side fix, markers / popups, failure screenshots, touch + keyboard, unit tests, Linux CI.

## Phases 1–4 (2026-09-20)
- Adapter seam, engine, MapLibre adapter, retrying matchers, actionability, click-time verification,
  text snapshot + accessibility mirror for agents, vector tiles from GeoJSON, packaging.
