# Changelog

Not published; versions start when the package does. Until then this lists what changed per phase
(details and reasoning: `the design notes`). Breaking changes are marked **BREAKING**.

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
