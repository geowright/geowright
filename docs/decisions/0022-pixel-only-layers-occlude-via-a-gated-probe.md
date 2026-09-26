# 0022. A pixel-only layer drawn above a target is checked by a pixel probe of the target, run only when one covers the aimed point

- Status: Accepted
- Date: 2026-09-26
- Decided by: Shai Sinai
- Amended 2026-09-26: issue references replaced by descriptions; the decision is unchanged.

## Decision
Before real input goes to a feature, if a visible layer that the hit test cannot see (raster, image, video, canvas,
hillshade, color-relief, background, custom, heatmap) is drawn above the target's layer and may draw at the aimed pixel, the
action probes the pixels of the TARGET's own layer there. If hiding that layer changes nothing, the pixel counts as
occluded. With no such layer, no probe runs and the action pays nothing. The probe never runs at click time.

## Why
The hit test returns features only, so an opaque overlay above a feature did not stop an action. Probing the
overlay is unsound: a translucent radar adds pixels and hides nothing. A verdict from style alone (option C) refuses clicks in
the transparent gaps of an opaque-styled raster. Probing on every action (option A) costs every map four renders and a
source reload (the options and the measurements: docs/DESIGN.md "Actionability", "Pixel-only layers: the options
weighed"). The gate limits the cost to maps that have an overlay above their features. This rules out
probing at click time, because the probe would reload the target's source while the app's own click handler runs.

## Consequences
- easy: an opaque veil or overlay refuses the action and the failure names it. A translucent or gappy overlay does not. Maps without one pay nothing.
- costs: on a map with an overlay above the features, each action costs a probe (4 renders) and on Mapbox GL v1 a possible
  one-frame flicker. Where the target's opacity is data-driven, each action also waits for the source reload. Pixels that
  change inside an existing overlay between the aim and the press are not re-checked. `moving: 'allow'` is not checked
  at all (the target's pixel changes between a probe and the press).
- This widens "topmost" in 0019 to pixel-only layers. It makes the probe of 0005 automatic inside actions, only when gated.
  0005's "opt-in" stands for visibility queries.
- enforced by: the pixel-only-layer specs in `tests/act.spec.ts`: opaque veil refused, translucent and gap cases pass, a raster below
  costs no probe, the reload race, and a sabotage spec for a veil that appears between aim and press; the same on every
  version in `tests/compat/compat.spec.ts`, and on a globe in `tests/wild/globe-vector.spec.ts`.

## More
- docs/DESIGN.md "Actionability": item 4, and "Pixel-only layers: the options weighed" (with the evidence);
  "Costs and known limitations"
- 0005, 0019
- src/inpage/maplibre-adapter.ts `probePixels`; src/inpage/types-internal.ts
