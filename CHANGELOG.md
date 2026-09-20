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

## an earlier phase (2026-09-20)
- **BREAKING** queries match VISIBLE features by default (`visible: 'any'` opts out).
- Visibility (paint evaluation + pixel probe), dense-map candidates, drawing helpers, `toHaveGeometry`,
  globe far-side fix, markers / popups, failure screenshots, touch + keyboard, unit tests, Linux CI.

## Phases 1–4 (2026-09-20)
- Adapter seam, engine, MapLibre adapter, retrying matchers, actionability, click-time verification,
  text snapshot + accessibility mirror for agents, vector tiles from GeoJSON, packaging.
