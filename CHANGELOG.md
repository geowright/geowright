# Changelog

Notable changes to geowright, newest first. While the version is 0.x a minor version may change the API; such changes
are marked **BREAKING**. The reasoning behind each behaviour is in `docs/DESIGN.md`.

## 0.1.0 — 2026-09-27

The first published version.

**Assert and act on a WebGL map from Playwright**: MapLibre GL JS 2, 3, 4, 5, 6 and Mapbox GL JS 1.13 (the support
table in the README says what is checked on which version). The app needs one line to register the map. It imports
nothing, and nothing ships with it. In TypeScript, `/// <reference types="geowright/app" />` makes that line compile
as written (it adds types only).
- **Assert** with retrying matchers (`.not` supported): `toHaveFeature`, `toHaveFeatureCount`, `toBeVisibleOnMap`,
  `toHaveLayerPixels` (raster, image, canvas, video, heatmap, hillshade), `toHaveGeometry` (the full geometry from the
  source, not the tile-clipped one), `toHavePopup`, `toHaveView`. A verdict of absence (a `.not`, a count, "not
  visible") is taken only from a map that has settled: idle, or seen to be one that never becomes idle. A matcher that
  cannot reach a verdict fails whichever way it is written, and says why: the map is not registered or was removed, a
  named layer does not exist (to assert that a layer was removed, check `map.layers()`), several features match where
  one is required, the camera is moving (`toHavePopup`). A removed or 0×0 map is an error for `features(q).count()`
  and `all()`, never an empty map.
- **Query** by `layer`, `layerType`, `source` (for layer ids a wrapper generates), `id`, `where` (equality, RegExp,
  `eq ne gt gte lt lte in matches exists`; any other value, such as an array or an unknown operator, is an error),
  `at` a location (one on the far side of the globe or behind a mountain matches nothing). By default, queries match only what a user can SEE. The
  style's paint properties are evaluated for each feature: opacity 0, a transparent colour and zero size do not count
  as visible. A layer's `visibility` (including a `visibility` expression, MapLibre 5.16+), `minzoom` and `maxzoom`
  are respected. `visible: 'any'` opts out. Features need no ids: identity is id + properties, and look-alikes are
  told apart by where they are drawn.
- **Act** with real input only (`page.mouse` / keyboard / touchscreen, CDP for multi-touch, never `map.fire()`):
  `click`, `dblclick`, `rightClick`, `hover`, `tap` on a feature; the same at a location; `dragTo`, `dragBy`, `dragAt`,
  `wheelAt`, `keyboard.press`; `pinchAt`, `twoFingerRotateAt`, `touchDragAt`, `doubleTapAt` (Chromium). Draw helpers
  (`polygon`, `line`, `rectangle`, `circle`, `cancel`) take explicit finish gestures and are tested with terra-draw and
  mapbox-gl-draw.
- **Actionability**: before any input, the target must be the only match, painted, still, under the pointer, the
  topmost visible hit, and not covered by a DOM element. For `click`, `dblclick`, `rightClick` and `tap`, the hit test
  runs again when the press arrives and must find the same feature (not a look-alike that slid under the pointer); a
  late press is swallowed, a tap's touch events included, and retried. A press that reached the app is never
  sent again: not when the app re-creates its map in the click handler, not when the click navigates. Options: `force`,
  `ignoreLayers`, `autoPan`, `modifiers`, and `moving: 'allow'` for a feature that never stops moving, on `click`,
  `dblclick`, `rightClick`, `tap` and `hover` (the pointer leads it; it can time out, but it never clicks the wrong
  thing). `dragTo`, `dragBy` and `lngLat` refuse `moving`, in their types and at run time: they have no check when the
  input arrives.
  Works on rotated, pitched, globe and terrain maps, and inside a container scaled with CSS `transform: scale()`. A location on the far side of the globe or behind a mountain is
  an error, never a click on something else.
- **When it fails, it says what WAS on the map**: the features per layer with their properties, the values of the
  property you asked about, and the reason. Reasons: not rendered, layer hidden, off-screen, occluded (naming the
  occluder), ambiguous, or not visible. For "not visible" it names the style property, its value, the expression
  branch that produced it and the zoom (`fill-opacity is 0 because the match on ["get","kind"] took its fallback for
  kind="park"`). A failure also attaches a screenshot with every pixel it tried marked on it, and every successful
  action records the pixel it used.
- `waitForIdle()`, and when the map never becomes idle, why: an animated source, a source re-set in a loop, continuous
  repainting, tiles still loading, a moving camera, or a dead MapLibre web worker. Timeouts follow the test's own
  timeout (actions a third of it, at least 10 s; `waitForIdle()` two thirds; matchers use Playwright's expect timeout).
  An action's timeout is wall-clock, its failure report included, even on a page too busy to answer, and an action
  with several points (a drag, a shape) has one timeout for all of them. As in Playwright, `timeout: 0` means no timeout.
- DOM markers and popups as normal Locators (`map.marker()`, `map.popup()`), pinned to their element.
- **Typings**: `expect` is typed from `@playwright/test` alone (so it keeps its matcher types under pnpm and Yarn PnP),
  every type a public signature names can be imported from `'geowright'` (`LayerInfo`, `SnapshotOptions`, `WhereValue`,
  `ActionPointOptions`, `Pt`, and `GeowrightMatchers` for merging `expect`s), and `types` / `typesVersions` let
  resolvers that do not read `exports` find `geowright`, `geowright/tiles` and `geowright/app`.
- **Vector tiles without a tile server**: `routeVectorTiles()` / `vectorTileHandler()` (`geowright/tiles`) cut real MVT
  tiles from GeoJSON inside `page.route`.
- **Browser agents** (Playwright MCP): a text snapshot of the map with clickable pixels and evaluated colours, and an
  accessibility mirror that makes features clickable buttons (`dist/inpage.js`, `dist/inpage-agent.js`, `--init-script`).
  On a basemap with 100 layers, the snapshot shrinks the basemap first so that the app's own features stay listed.
- `npx geowright init` writes a fixture, the software-WebGL flags and a first spec that prints the snapshot. It also
  prints the hook for your wrapper (react-map-gl, svelte-maplibre-gl, vue-maplibre-gl). A whole `playwright.config` is
  written only where there is none.
- Every example in the README and `docs/RECIPES.md` is type-checked and runs in the test suite.
- Tested against 33 apps its authors did not write: 23 MapLibre examples, plus 10 apps built on react-map-gl,
  svelte-maplibre-gl, vue-maplibre-gl, deck.gl's `MapboxOverlay` and PMTiles (`wild/`). If geowright does not work on
  your app, `wild/README.md` ("Bring your app") shows how it becomes one of them. Known limitations:
  `docs/DESIGN.md`, "Costs and known limitations".
- Apache-2.0. The injected scripts bundle MapLibre's style-spec evaluator and three small libraries; their licenses ship
  as `dist/THIRD_PARTY_LICENSES.txt`. In the repository, the third-party code and fonts under `wild/` and `demo/`
  (the test apps' builds, their fixtures, the demo's MapLibre build and glyphs) have their license texts beside them.

Requires Node 22 or newer and `@playwright/test` 1.49 or newer (peer dependency). CI runs the full suite on Chromium
with Playwright 1.49.0 and with the current version.
