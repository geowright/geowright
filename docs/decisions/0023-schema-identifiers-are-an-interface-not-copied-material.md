# 0023. The identifiers a style must match to work with a vector-tile schema are an interface, not copied material

- Status: Accepted
- Date: 2026-09-26
- Decided by: Shai Sinai (on the coordinator's recommendation)

## Decision
The synthetic basemap (`tests/wild/basemap.ts`) may use the OpenMapTiles schema's source name, source-layer names and
field names, and the OSM Bright layer ids that vendored examples refer to. Its data, geometry, colours and style are
generated here. Nothing of OpenMapTiles' data or tiles, and nothing of the OSM Bright style (its JSON, colours, sprites,
geometry), is committed. `docs/THIRD_PARTY_NOTICES.md` and the file's header say where the names come from.

## Why
Two sets of names, two arguments. Both licence texts were read on 2026-09-26.
- **Source-layer and field names** (`transportation`, `render_height`, …) are defined in the schema's code.
  `openmaptiles/openmaptiles` `LICENSE.md` (commit `de2fa04c37390824f09dfafbff00ccf045f84c08`) puts that code under
  "Code license: BSD 3-Clause License", which is on the allowlist (0020). Its CC-BY 4.0 part covers only "The
  cartography and visual design features of the map tile schema (also known as the "look and feel" of the map)". The
  names are also the interface any style must match to read such tiles.
- **Layer ids** (`water`, `building`, `poi_r1`, …) are what the vendored MapLibre examples look up (`beforeId`,
  `setPaintProperty`), so the stand-in must have them. `openmaptiles/osm-bright-gl-style` `LICENSE.md` (commit
  `65c699326edce05da9bbda2c53116314259f1503`) puts "The visual design features of the style (also known as the "look
  and feel" of the map)" under CC-BY 4.0, which is not on the allowlist. An id is not that design; the design is not copied.
- Both texts ask "Products or services using maps derived from OpenMapTiles schema" to credit OpenMapTiles. No map here
  is derived from OpenMapTiles data or design; the courtesy line costs nothing. A credit line alone would not have made
  CC-BY material acceptable (0020): the question is whether anything CC-BY is copied, and it is not.

## Consequences
- easy: the wild apps run against the contract they were written for, offline, with nothing CC-BY or ODbL in the tree.
- costs: the identifiers must stay identifiers: copying the OSM Bright style's paint, its sprites or any real tiles is
  still ruled out by 0020.
- enforced by: review (not a check); `wild/fixtures/SOURCES.md` keeps the real style and tiles "NOT committable".

## More
- 0020; docs/THIRD_PARTY_NOTICES.md; `tests/wild/basemap.ts`; wild/fixtures/SOURCES.md
