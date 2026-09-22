# 0005. Visibility: evaluator first, pixel probe for ground truth

- Status: Accepted
- Date: 2026-09-20
- Decided by: Shai Sinai

## Decision
Visibility is decided by evaluating a feature's paint properties with MapLibre's own style-spec
expression evaluator, with an opt-in pixel probe as the ground-truth check on top of it.
When the evaluator meets an expression newer than it understands, the feature is reported
visible, never a false "invisible".

## Why
A rendered-feature query returns features painted with zero opacity, zero radius, or a fully
transparent color as if they were ordinary hits, so a plain existence check can pass on something
no user could ever see. Paint evaluation is cheap and can explain a failure by naming the property
that hid the feature, but it cannot see a transparent icon image or a color equal to the
background — that gap is what the pixel probe closes. Always answering "visible" when the
evaluator is unsure rules out the worse failure mode: silently hiding a feature that is really there.

## Consequences
- easy: queries and assertions default to what a person can actually see, with a diagnostic naming the exact hiding property
- costs: an app using a style expression newer than the bundled evaluator degrades silently to "visible" with a warning; the pixel probe is opt-in because it costs real time and briefly reloads the layer's source
- enforced by: default query behavior in `src/playwright`, the `toBeVisibleOnMap()` matcher; not enforced by a check that detects a widening evaluator gap

## More
- README.md "Visible by default"
- docs/DESIGN.md "Visibility: rendered is not visible"
- src/inpage/maplibre-paint.ts
