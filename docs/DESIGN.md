# Design

This document explains the decisions behind geowright and the evidence for them: what was tried,
what broke, and what the numbers said. It assumes familiarity with the [README](../README.md) —
this is the "why," not the API reference.

## Two gaps in DOM-only testing: ASSERT and ACT

A MapLibre map renders to a single WebGL canvas. Everything a normal Playwright suite is good at —
finding an element, reading its text, clicking it, waiting for it to appear — stops working the
moment the thing under test is a pixel inside that canvas rather than a DOM node. This leaves two
gaps in an otherwise ordinary end-to-end suite:

- **ASSERT** — after driving the application's normal UI, verify that something was added to,
  changed on, or removed from the map (a marker appeared, a layer's data changed, the camera moved
  to the right place).
- **ACT** — perform actions that start on the map itself: click a feature, right-click a location,
  drag a vertex, draw a shape.

geowright closes both gaps for MapLibre GL JS (developed against 6.10; versions 2–6 and the BSD-licensed
Mapbox GL JS 1.13 are covered by a version matrix, see "Version compatibility") with a small in-page engine
plus a Playwright binding, and takes a **grey-box** stance to do it: it can read the map's public
state (rendered features, paint properties, camera, layer list) to decide what to click and what to
expect, but every action it performs is **real input** — `page.mouse` and CDP touch/keyboard events
at real screen pixels, dispatched the same way a person's input reaches the browser. It never calls
`map.fire()` or otherwise synthesizes a DOM or map event. CDP's own `Input` domain (which is what
Playwright's mouse and keyboard already use) is fine; anything that skips the browser's real input
pipeline is not. The library's own claim that "real input matters" is not a slogan: it is backed by
several bugs described below that a synthetic-event test would never have found, because the
application's own event handling — not the test's assumptions — is what was actually broken.

The adapter is built against **MapLibre's public API only**. No private fields, no internal render
flags, nothing that could silently change across a minor version. This shows up most concretely in
one design choice described under actionability: an existing prior-art library (MapGrab, see below)
decided whether the map was "stable" by reading MapLibre's private internal flags directly
(`_styleDirty`, `_repaint`, `scrollZoom._lastWheelEventTime`, and others). Reading private fields
ties a testing library to implementation details that are free to change on any release, which is a
plausible reason that library stopped being maintained. geowright's stability check is built
entirely from public surface instead (described below).

All of this sits behind one seam: `CanvasAdapter<W>`, in `src/inpage/types.ts` (additions that are internal until 1.0,
such as the failure-message explanations, extend it in `src/inpage/types-internal.ts`, outside the published
typings). The engine that
does query matching, action-point selection, and diagnostics has **zero imports from MapLibre or
any other map library** — every library-specific behavior is one method on the adapter interface,
most of them optional so an adapter can simply not implement what its library cannot do. The
vocabulary is deliberately generic where it can be: a "world" coordinate is whatever the underlying
library's native coordinate space is (`{lng, lat}` for a map, but the type is a generic `W`); a
"surface" is the DOM element that receives real input; a "feature" is an addressable thing drawn on
the surface, grouped into "layers." The MapLibre adapter that implements this seam is small (a few
hundred lines); everything else — retrying handles, strict-vs-set matching, the "what was
actually on the map" diagnostics, the matcher library — has no idea it is talking to a map.

That generality is real but uneven. It extends cleanly to anything with a retained scene and a
programmatic pick/hit-test — deck.gl, OpenLayers, Leaflet, Cesium, and 2D scene-graph libraries like
Konva, Fabric, or ECharts all expose something equivalent to "what is rendered here" and "where does
this world coordinate project to." It does not extend to immediate-mode canvas content (a raw 2D
context, most games, many charts) where there is no queryable model at all without the application
doing extra work far beyond a one-line hook. Two things are specifically true of maps and not of
canvas content in general: a real settle signal (`idle`, discussed below — most canvas apps have
nothing like it), and a universal, application-independent addressing scheme (`{lng, lat}` — a
canvas editor's coordinate space is whatever that application invented). "A testing layer for
retained-mode, pickable canvas libraries, maps first" is an accurate description of the design;
"a testing layer for the canvas web" would not be.

## The one-line hook, not auto-discovery

Getting a handle on the map instance is the first problem any tool like this has to solve, and the
options were narrower than expected.

**Auto-discovery of the map instance is not possible for a bundled ESM application, not merely
fragile.** MapLibre GL JS 6 ships ESM-only: there is no UMD build and no `window.maplibregl` global
to intercept. The one auto-discovery trick that has ever worked against a global-exposing library —
inject a script before the page loads, trap the global, and patch the constructor it exposes — has
nothing left to patch: in a bundled application the `Map` class is a module-private binding, never
assigned to `window`. The instance itself is unreachable from outside: the container DOM node holds
no back-reference to the map that was constructed around it, and its event handlers are bound
closures with no enumerable path back to the instance. `tests/discovery.spec.ts` turns this claim
into an executable check against a real bundled application: it looks for a library global, walks
every enumerable property of `window` for anything shaped like a map, and walks the map container's
DOM subtree (including symbol keys, to catch framework-added expandos) for a back-reference. All
three come back empty; only the explicit hook is found. If that test ever starts failing, the
premise behind the hook would need to be revisited.

The remaining ways to get "automatic" discovery are all worse than a one-line hook: rewriting the
application's bundle inside `page.route` (a regex over minified, unstable code) or a
framework-specific search (walking React's fiber tree to find a wrapper component's ref). Neither
is robust across bundlers, minifier settings, or framework versions, and neither was pursued past
the idea stage.

The one relevant piece of prior art, an archived MIT-licensed library called MapGrab that solved the
same ASSERT/ACT problem for MapLibre and Mapbox GL, made the identical call: an explicit
`installMapGrab(map, id)` call in application code. Nobody building this kind of tool has found a
way around an explicit registration step. geowright's version is lighter — a dependency-free global
assignment instead of an imported function:

```ts
const map = new maplibregl.Map({ ... });
(window.__geowright_maps ??= {}).main = map;
```

Nothing is imported, so the application ships zero test code in production and never depends on the
testing library. The in-page adapter and engine are injected separately, by the test runner
(`page.evaluate` of a pre-built bundle, re-injected after every navigation); duck-typing on the
registered object picks the right adapter. The one line is meant to live only in a test or
development build, for reasons covered next.

Applications that wrap MapLibre in a component library still reduce to one line, just moved to
wherever the wrapper first hands back the underlying map instance — typically a load callback:

```jsx
<Map onLoad={e => ((window.__geowright_maps ??= {}).main = e.target)} …                />  // react-map-gl
<MapLibre onload={(e) => ((window.__geowright_maps ??= {}).main = e.target)} …          />  // svelte-maplibre-gl
```

Vue is the one wrapper where the naive line does not work: a Vue **template** expression cannot see
`window` at all, so the documented one-liner throws there. Inside `<script setup>` the plain line is
fine; from a template the working form reaches `window` through the DOM node's own document instead:

```jsx
<mgl-map @map:load="e => ((e.map.getContainer().ownerDocument.defaultView.__geowright_maps ??= {}).main = e.map)" … />
```

A second wrapper-specific wrinkle worth stating plainly: a wrapper's load callback fires only when
the underlying library's own `load` event fires, and `load` needs every declared source to resolve.
If one data request fails, the map is never registered, and the hook's caller sees only "no map
registered" after its timeout — a message that points at the hook, not at the real cause. The test
harness lists every unanswered network request at teardown, which is how this gets diagnosed in
practice.

The hook has one security implication worth stating up front: it exposes the live map instance to
*any* script running on the page, which is why it belongs in test and development builds only, never
shipped to production. This is also, incidentally, a real affordance for browser-driven agents (see
the agent layer below): an agent poking around a page with the hook present can find and use
`window.__geowright_maps` on its own, with no instructions at all. Any application that adopts the
hook for testing becomes more legible to that kind of agent for free — and takes on the same
exposure for free.

## Actionability: what "click a feature" has to verify

A `click()` on a feature is not "compute a pixel and send a mouse event." Before geowright will
send real input for a feature action, all of the following have to hold, and the whole check re-runs
on every retry:

1. **The query resolves to exactly one logical feature** — strict, the same contract as a Playwright
   Locator. More than one match is an error naming the ambiguity, not a guess.
2. **The map is not moving, and the chosen pixel is stable across two animation frames.** This
   replaces reading private internal state (the MapGrab approach, discussed above) with two public
   checks: sampling the candidate pixel twice, one frame apart, and requiring the map's own
   `isMoving()` to answer false. An in-flight `flyTo` or animation is a wait, not a race.
3. **The pixel is actually on the feature.** Candidate pixels are generated geometrically and then
   *verified* by the library's own hit test — geometry code stays simple because it never needs to
   be exactly right, only close enough for the hit test to confirm it. For a polygon, candidates come
   from a grid over its on-screen bounding box (density scaled to the shape's on-screen size, from a
   dense 12×12 grid down to 3×3 for something the size of a few pixels), kept only if they fall
   inside the shape, and ranked by distance from the nearest edge — a cheap pole-of-inaccessibility
   approximation. The **centroid or bounding-box centre is never used**, because it can land outside
   a concave shape or inside a hole. For a line, candidates are ordered along the line and tried from
   the middle outward, not from either end. (An early version ranked by *array index* distance from
   the middle index, which for the typical vertex ordering of a line is almost always its first
   vertex — every line was being clicked near its start rather than its middle. It never failed a
   test, because a line's endpoint is also a point on the line, so the wrong pixel was still a valid
   one. It was caught by a small, fast unit test written directly against the candidate-generation
   function, after the end-to-end suite had missed it — the strongest argument found for
   keeping a fast unit-test layer underneath an inherently slow, browser-driven suite.) For a point
   feature, the first candidate is its own location; if that location is not clickable — buried under
   other features in a dense cluster — a ring of additional candidates around it (a few small radii,
   several compass directions each) is tried next, each still verified by the real hit test. On a
   stress page with several thousand overlapping point features, more than half had no clickable
   pixel at their nominal location at all (59% of entities); the ring candidates recovered 623 of those
   2,173 by finding the visible crescent a real user would have clicked instead. The rest are reported
   as occluded, naming the occluder.
4. **The feature is the topmost thing a person can actually see at that pixel.** A feature's own
   label rendered on top of it does not count as an occluder — putting a count label on a cluster and
   then finding cluster clicks newly "occluded by their own label" is what motivated this rule: labels
   sitting on their own feature are the norm, not an edge case. The comparison is on the underlying
   *data* feature (source, id, properties), not the rendered layer, so a foreign layer's label still
   occludes correctly. A feature that is rendered but invisible (opacity 0, a transparent color — see
   "Visibility" below) is likewise not counted as an occluder, on the reasoning that occlusion is
   about what a person can see, not about which layer receives an event first. The map's hit test returns
   features only, so a raster, image, video, canvas, hillshade, color-relief, background, custom or heatmap layer drawn
   above the feature needs pixels to decide (decision 0022; the options weighed are below the list). A **gate** first: is such a layer drawn above the
   target, visible, in its zoom range, with an opacity that is not exactly 0, and — where the style says where it draws —
   does its area hold the chosen pixel (an image, video or canvas source's `coordinates`, a point-in-quad test in
   Mercator; a tiled source's inline `bounds`; under terrain, no area test)? The gate may say yes too often, which costs
   a probe, never no too often. It takes < 0.1 ms on the 80-layer dense basemap, so a map without such a layer above its
   features (most maps; a raster basemap at the bottom) pays nothing. When the gate says yes, the **target's own
   layer** is probed at that pixel (see "Visibility" below): hiding it changes nothing there → the pixel is covered, and
   the next candidate is tried, at most three probes per aim; then the action fails `occluded`, naming the layer and
   offering `ignoreLayers`. Probing the overlay instead does not work: a translucent radar adds pixels and hides
   nothing. Deciding from the style alone does not either: an opaque-styled raster has transparent gaps. The verdict is
   kept, keyed by the target, the pixel, the camera, and the gated layers with their sources and opacity, so the retry
   does not probe again. Where the target's opacity is data-driven the probe hides it by `visibility` and its source
   reloads: the action then waits for a rendered frame, the source loaded, and the target back in the hit test at that
   pixel (event-based; measured: at most 2 frames, 115 ms quiet, 787 ms at load ~300), then aims again. `ignoreLayers`
   covers these layers too; `force` skips the check.
5. **No DOM element covers the pixel** — a popup, a control, an overlay. Checked with
   `document.elementFromPoint`, so a marker or popup sitting exactly on a feature's best interior
   candidate correctly blocks that candidate and the search moves on to the next one.
6. **The map is scrolled into the browser viewport** if it is not already, since no pointer can reach
   a part of the page that is off-screen — the same thing a Locator does before acting. A map larger
   than the window cannot be scrolled fully into it: a pixel outside the window is refused (for a
   location action too, and for a drag's release point, `force` or not — `force` skips the cover
   checks, not reachability), since input sent there never reaches the application.
7. **At the instant the real pointer event fires, the hit test is re-run at that exact pixel.** Between
   computing a target pixel in the page and Playwright dispatching input for it a few milliseconds
   later in the test process, the application could have moved the map. An armed, capture-phase
   listener re-checks the hit test at the pixel and moment of the real `pointerdown`; on a mismatch it
   swallows the whole click sequence (a tap's touch events included) before it reaches the application,
   and the action retries from the top. The browser still counts a swallowed tap, so the retried tap
   arrives as the second of a double tap (a `dblclick`, and MapLibre zooms): that `dblclick` is
   swallowed as well. A pixel-only layer over the pointer that the aim did not see the target through (a veil shown
   between the aim and the press) is checked there too, by the gate only: a probe at that instant would reload the
   target's source while the app's own click handler hit-tests it. What must be under the pointer is the feature the query
   resolved to when the check was armed — a piece of it, by key and, for an id-less feature, by
   touching its pieces — not merely something the query matches: an id-less look-alike that slides
   under the pointer is another feature. A moving target (`moving: 'allow'`) is resolved again when
   the event arrives, since its pieces from before the press no longer touch the ones drawn at it; the
   query must then match exactly one feature, as it had to when it was aimed at — with two matches, the
   one that happens to be under the pointer is not the one that was asked for. This closes the same class of race Playwright's own hit-target interception closes for
   ordinary DOM elements, and it was verified with a targeted mutation test: with the check disabled,
   a spec built to provoke the race fails; with it enabled, the same spec passes.

**Pixel-only layers: the options weighed.** Before item 4's check was written, four ways to handle an overlay that the
hit test cannot see were weighed against measurements (decision 0022 records the choice):
- **A. Probe the target's layer on every action.** Sound, but every action on every map pays four renders (the probe
  draws twice with the layer, once without it, and once after putting it back), and the probe as it was then, hiding the
  layer by `visibility`, reloaded the target's source right before the hit test that verifies the click.
- **B. Probe only when a gate says a pixel-only layer above the target may draw at the aimed pixel.** Chosen: a map
  without such a layer pays nothing, a map with one pays A's probe per action.
- **C. Decide from the style alone** (an overlay whose opacity is about 0.95 or more occludes). Cheap, but it guesses: a
  fully opaque radar raster is mostly transparent pixels, so clicks on features in its gaps would be refused. A false
  failure there is worse than the rare false pass it would replace.
- **Probe the overlay instead of the target.** Unsound: a translucent overlay changes the pixels and hides nothing.

Two measurements made B affordable (MapLibre 6 and 2, Mapbox GL 1.13; GeoJSON and vector tiles; 5 probes per target and
route). Hidden by `visibility`, the target left the rendering and the hit test after most probes, for at most 2 frames:
16 ms median and 115 ms at most on a quiet Mac, but up to 787 ms at a load of ~300. Hidden by its opacity, nothing
reloaded and no frame lacked the target, in 135 of 135 probes, with the same pixel differences. So the probe hides by
opacity, only a target whose opacity is data-driven pays the reload, and the action waits for that by events, never
for a fixed time (item 4; "Visibility" below). A probe costs 21 ms (median) on MapLibre 6, 15 ms on MapLibre 2 and 45 ms
on Mapbox GL 1.13, where its four renders are real frames, on a quiet Mac; software GL on Linux is slower. The gate
costs less than 0.1 ms on the 80-layer dense basemap.

Fill-extrusion (3D buildings) features need one more step: their clickable area is not their
footprint. A tall building's footprint can be scrolled entirely out of view while the tower itself is
still on screen. Action points for extrusions are lifted toward wherever the shape is actually drawn
— roof first, then partway down the walls, then the footprint as a last resort — using an estimate
(evaluated extrusion height, times an approximate on-screen pixels-per-metre scale measured along the
horizontal axis, which camera pitch does not foreshorten, times the sine of the pitch angle). MapLibre
exposes no public 3D projection to compute this exactly, but an estimate is sufficient because every
candidate is still verified by the real hit test — a wrong estimate produces a retry, never a wrong
click. Real data added one case the generated city never had: building PARTS that float (a roof slab from 120 m to
132 m, `fill-extrusion-base`). "Half-way up from the ground" is thin air for those, so the tiers run between the
base and the top; and an extrusion whose footprint is outside the viewport, with at most a sliver reaching into it,
is reported as off-screen with that explanation rather than as "not found".

**Whole pixels.** Real input is dispatched with fractional coordinates (a `pointerdown` at 339.6, 641.4), but map
libraries handle `click` and `mousedown` — MouseEvents, whose coordinates the browser truncates (339, 641). For a long
time candidates were verified exactly where they were computed, fractions included, and nothing noticed: features are
usually many pixels wide. A dense, label-heavy basemap noticed. The edge of a point-of-interest label ran between the
two positions; the hit test at the fractional pixel said "the building is on top", MapLibre's own click handler, one
truncation later, said "the label is". Candidates are now snapped to whole client pixels BEFORE they are verified, the
snapshot lists whole pixels, and for shapes thinner than a pixel (a country squeezed against the limb of a globe) the
four whole pixels around a candidate are tried as well. The general lesson: verify the pixel the application will see,
not the pixel you computed.

**Targets that never stop moving.** The two-frame stability check refuses a perpetually animated feature for ever on a
page that keeps drawing (a page that stalls is under "What is still wrong") — correct, and stricter than a person, who
can click a slowly moving dot. `{ moving: 'allow' }` drops the two checks a
moving target cannot pass (map at rest, same pixel two frames running) and keeps every other one; what protects against
acting on the wrong thing is the click-time verification, which swallows a late press before the application sees it.
It runs at the press; a target that moves off between the press and the `click` event is under "What is still wrong".
Measured before designing: on a light page the freshest pixel is good enough (a 9 px dot at up to 200 px/s: 20 of 20
first try; at 400 px/s: 0 of 20, every press swallowed, none delivered elsewhere). On MapLibre's own "animate a point"
example — a full-screen basemap in software GL, ~14 frames a second — it never hit once in 30 s, because input arrives
200–500 ms after the pixel was computed. So the pointer LEADS: velocity and acceleration are measured over three frames
(a straight-line lead of 300 ms leaves a 114 px circle by 5 px), the click-time check is armed before the pixel is
computed (every round trip after it is lateness), and how far to lead is learnt from each miss — the verdict reports
where the target was when the event arrived; lead + lateness is that attempt's measured latency, and the median of the
last few is used (a full-gain correction chased frame-sized jitter and never settled). Result on that example under five
parallel workers: click 30 of 30 — and one timeout in three full-suite runs on a loaded machine, every late press
swallowed. Landing the click depends on the machine; not mis-clicking does not, and only that is asserted in the suite. `hover` is weaker and is documented as such: a `mousemove` is delivered on a frame
boundary, so its lateness jitters by whole frames — more than the ~175 ms that dot spends under any pixel (14 of 30
there); it is dependable when a frame is short compared with the target's dwell time.

**Bounded search.** Candidate generation is cheap per candidate but not free in aggregate: a large,
mostly-covered polygon (a country outline mostly hidden under smaller regions on top of it) produced
tens of thousands of geometric candidates and took on the order of 25 seconds per action before this
was addressed. The fix keeps grid density proportional to on-screen size, ranks every part's
candidates together by depth-from-edge instead of exhausting one part before the next, and caps the
whole search at **600 hit tests** — past that bound the action reports the feature as occluded and
names what is on top, rather than continuing to search for an ever-smaller sliver that a real user
would not hunt for either. On the case that motivated this, the same action went from tens of
thousands of candidate pixels to roughly two thousand and well under two seconds.

## Identity: matching a click back to a feature

MapLibre's rendered feature `id` cannot be trusted as a stable key on its own. It keeps an id only if it
is a non-negative integer: a GeoJSON id goes through its tile encoder, which parses a string id as an
integer and writes any number as an unsigned integer (a UUID string id from a drawing library becomes
something like `0`, `4`, `75`, or `8866` — the leading digits, colliding across genuinely different
features; `'north-gate'` becomes `0`, `-5` becomes 18446744073709552000, `1.5` becomes `1`; Mapbox GL 1
drops a non-numeric one), and the same feature comes back once per internal tile it happens to be sliced
into, each time with a different, clipped piece of its geometry. For this reason **identity is
`layer + id + properties`, and geometry received from the renderer is treated as a possibly-partial
piece, never the authoritative shape** — the full shape, when it is needed (drawing / geometry
assertions), is read from the source's own data instead. Property objects are compared by their values
with keys in a stable order: tile generations and source data can enumerate the same fields differently,
and that difference must not split one feature into two identities. Ids are unique within one
source-layer of a vector source only, so a feature's source-layer is part of its identity too.

The key is safe, but not collision-free, and a query is by the app's id, not the renderer's:

- **A query by an id the renderer does not keep** (`{ id: 'north-gate' }`) is resolved through the
  source's data, for a GeoJSON source: the data features with that id, then the rendered pieces with
  their properties — and, when a look-alike shares those properties, the pieces that touch the data
  feature's own geometry. On a tiled source such an id can never be drawn, so the query is an error that
  names `promoteId` (the id then comes from a property and is kept as it is) instead of matching nothing,
  which made every negative assertion by it pass. Left as a limit: in a source that mixes both kinds of
  id, a query by an integer id also matches a feature whose id is drawn as that integer.
- **Look-alikes whose ids are drawn as one number** (`'north-gate'` and `'south-gate'`, both `0`, same
  properties) share a key. When the pieces of such a key do not touch, the source is asked how many
  features it holds with those properties that could have been drawn with that id; if more than one,
  the key is split by contact like id-less pieces (below).
- **Data and rendered properties differ in form.** The tile encoder drops a property whose value is
  `null`, and MapLibre before 6 / Mapbox GL deliver a nested object as its JSON string. Wherever a data
  feature is matched to rendered ones (full geometry, the snapshot's "not drawn" count, the proofs
  below), both sides are compared without null values and with JSON strings read as what they hold.

Related layers that draw one logical thing are folded into a single entity for the purposes of a
handle or a snapshot row — a circle, its label, and its outline, drawn on three separate layers, are
one entity with a primary layer and a list of the others it also appears on. This matters because a
typical map style renders one real-world thing across several layers on purpose (fill + outline,
point + label), and treating those as unrelated features would make ordinary queries and counts
wrong.

Two harder identity problems only showed up once the library was pointed at applications it was not
built around:

- **Features with no id and identical properties.** Several point-of-interest markers that are all
  `{ icon: "music" }`, with no id field at all, key identically under `layer + id + properties` and
  therefore collapse to one feature — which is correct when a wrapper renders one real entity as
  several coincident pieces, and wrong when they are genuinely distinct entities that merely look
  alike. Geometry cannot settle this (tile-clipped pieces of one shape look nothing alike), but
  *contact* can: same-key, id-less pieces are grouped by whether their on-screen bounding boxes touch,
  using a sweep over the boxes rather than an all-pairs comparison. Two id-less, property-identical
  shapes that visually touch are still counted as one feature — a documented limit of this approach,
  not something contact alone can resolve.
- **The same feature, seen through re-rendering, briefly disagreeing with itself.** An application
  that replaces its entire GeoJSON source on every animation frame can, for one instant, be caught
  mid-swap, rendering the same logical point from two different generations of that data roughly
  thirty pixels apart — which look exactly like two nearby id-less pieces that do not touch. When a
  split like this happens unexpectedly, the adapter can ask a GeoJSON source directly whether its
  *current* data holds exactly one feature with those properties, and trust that answer over what the
  renderer momentarily disagreed with; a vector-tile source cannot be asked this question at all, so
  for tiled sources the split from re-rendering stands as-is.
- **World copies.** At low zoom, a web-Mercator map draws the whole world more than once side by
  side. The same id-less feature then appears in each visible copy, and identity keys built purely
  from screen position would treat those as separate features. The adapter can report the pixel
  period the surface repeats at, and pieces are compared modulo that period, so multiple on-screen
  copies of one feature merge back into one identity. Compared, not folded one by one: folding each
  piece by where its own left edge falls tore two touching tile pieces of one line apart whenever their
  left edges fell on either side of a multiple of the period (one tiled line read as two features, and
  a click on it as a strict-mode violation).

A residual, unresolved case: under deliberately heavy concurrent load, roughly one time in twenty an
animated point occasionally reports itself as "ambiguous" rather than the more accurate "unstable" —
the action still correctly refuses to click either way, but the diagnostic label is sometimes wrong,
and the specific cause was not isolated.

## Visibility: "rendered is not visible"

MapLibre's `queryRenderedFeatures` documents, and testing against 6.10 confirms in practice, that it
returns features the style paints completely invisibly: `circle-opacity: 0` (constant or data-driven),
`circle-radius: 0`, a circle color with zero alpha, and `text-opacity: 0` all come back from a
viewport query exactly as if they were visible; a point query at a specific pixel returns all of these
except zero-radius. A plain "does this feature exist" query can therefore pass on something no user
could ever see. The trap is broad, not an edge case, so it is addressed as a default rather than an
opt-in check.

**Paint evaluation is the everyday mechanism.** MapLibre's own style expression evaluator is published
separately as `@maplibre/maplibre-gl-style-spec` and is bundled into the injected script; the public
`getPaintProperty` / `getLayoutProperty` accessors give the raw style values, and the bundled
evaluator resolves them for a specific feature — handling data-driven expressions, zoom-dependent
values, per-feature state, and global state exactly as the renderer itself would. This costs
microseconds per feature, needs no rendering, and can explain itself in a failure message (for
example, "`circle-opacity` evaluates to 0"). What it cannot see: a genuinely transparent icon image
(nothing about the icon's *pixels* is visible to a paint-property read), or a color that happens to
exactly match whatever is drawn underneath it.

"Exactly as the renderer" needed two corrections, both found by comparing the verdict with the pixel probe. A
**zoom-and-data** ("composite") paint expression is not evaluated at the camera zoom: MapLibre evaluates it per tile, at
the tile's zoom z = floor(zoom + log2(512 / tileSize)) and at z+1, and the shader blends the two by the expression's own
interpolation factor at the camera zoom (`CompositeExpressionBinder`). A `step` on zoom therefore switches at the next
whole tile zoom, not at its stop: `["step", ["zoom"], 0, 11.5, ["get", "o"]]` draws nothing at zoom 11.7. The evaluator
now does the same. Since MapLibre 5 tiles of one view can have different zooms (terrain, a pitch past about 60°, a globe
past tile zoom 4); there a composite value that hides the feature at the centre's tile zoom but not at every other one
is *uncertain*, reported as "visible" with a caveat, never as a confident "invisible". And `within` / `distance` need the
feature's tile geometry, which the evaluator does not have (they evaluate to false / NaN without it): an expression that
uses them counts as "cannot evaluate" — visible, with the same caveat as an expression newer than the evaluator.

Because of that gap, an **opt-in pixel probe is the ground-truth check**, run once a passing paint
evaluation has already said "visible." A WebGL canvas without `preserveDrawingBuffer` reads back all
zeros shortly after a frame is drawn — except within the same JavaScript task as the draw itself. The
probe exploits this and MapLibre's public, synchronous `redraw()`: redraw with the layer on, read
pixels, hide the layer, redraw again, read pixels again, restore the layer, redraw once more — all in
one task, so nothing is ever actually composited to the screen and there is no visible flicker. A
non-zero difference between the two reads means the layer contributed real pixels at that location.
Measured warm, on a quiet machine, this costs on the order of 25–27 ms per probe (one call was
measured at 205 ms, attributable to a source reload the first probe triggers, discussed next); an
early, informal measurement taken while the machine was under heavy unrelated load suggested
85–180 ms, which is the number to distrust. The probe has two real costs beyond time: it fires
MapLibre's `styledata` event, so an application with its own `styledata` listeners will see that; and the
differential it measures is per *layer* at a pixel, not per feature, so a second feature from the same layer under
the same pixel confounds it.

How it hides the layer matters. With `visibility: none`, MapLibre reloads the layer's source (every source type
but raster), and the tiles that come back from that reload lack the layer: right after the probe the feature was
missing from the rendering and from the hit test, for 10–60 ms on a quiet machine and more under load, until the
reload after the restore landed — on MapLibre 2 and 6 and Mapbox GL 1, GeoJSON and vector tiles alike. A **paint**
change reloads the source only when the old or the new value is data-driven (feature properties or feature-state) or
cross-faded (`StyleLayer.setPaintProperty`, the same in all of them). So the probe hides the layer by setting its
opacity properties to 0 (`fill-opacity`; `line-opacity`; `circle-opacity` and `circle-stroke-opacity`; `icon-opacity`
and `text-opacity`; `fill-extrusion-opacity`) with a zero transition, puts back the app's values, and puts back the
app's transitions only after a frame has drawn the restored value (earlier, the restore itself would fade in). Nothing
reloads and the feature never leaves the hit test (`tests/visibility.spec.ts`, and the compat matrix on every
version).
Only a layer whose opacity is data-driven (or a type without one) is still hidden by
`visibility`, and pays the reload.

Three corrections to the probe. It reads the layer-on pixels **twice**: if they differ, something else is
changing the pixels there (a fade, an animation under the feature, a camera that never stops), and hiding the layer
counts only if it changes them clearly more (more than twice the control difference); otherwise there is no verdict
yet. (A first version refused any control difference and turned "the trace is visible" on MapLibre's forever-panning
realtime example into "no verdict"; a camera drifting a few pixels between reads is noise, a yellow line is signal.) (A control after the restore does not work where the layer was hidden by `visibility`: it is not drawn again until its source has reloaded.
MapLibre 2–4 advance a paint transition only on a style change — the probe's own hide is one — so there a transition in
progress under the feature can still pass for a contribution.) Without `redraw()` (Mapbox GL JS v1) the reads are real frames: their wait is budgeted from the matcher's
remaining time, and a frame that does not come is "not yet", never a silent pass on paint alone. And
`toBeVisibleOnMap` runs it once per verdict, as intended: a conclusive result is reused while the feature looks the same
(re-probed after 1, 2, 4… s), instead of re-rendering the map four times on every poll of a waiting `.not`. The restore puts back
what the app had only if the layer is still hidden by the probe; an app that hides the same layer in the frames between
(Mapbox GL v1) cannot be told apart from the probe and is still undone.

Query semantics default to what a person can actually see: `visible: true` (implicit default) matches
only paint-evaluated-visible features; `'any'` opts back into MapLibre's own broader notion of
"rendered," including opacity-0 features; `visible: false` matches only the invisible ones. The
stricter matcher, `toBeVisibleOnMap()`, runs both checks — paint evaluation and, by default, the pixel
probe (`{ pixels: false }` skips the probe where it is not needed). Feature actions refuse to act on
an invisible match by default (`{ force: true }` overrides): a user cannot click what they cannot see,
and a test that tries to is very likely testing the wrong thing.

A layer that paints something but has **no individually addressable features at all** — a raster tile
layer, an image or video layer, a hillshade layer, a heatmap — cannot be asked about through feature
queries, since there is no feature to query. `toHaveLayerPixels(layerId, { at, radiusPx })` runs the
same redraw/read-back probe over a radius around a location instead of a single feature's pixel; an
early version read a 5×5-pixel patch and reported "nothing" for a real radar image, because imagery is
transparent at any single spot often enough — the default is now a 24-pixel radius. (The same lesson a
second way: a spec that probed the centre of a canvas source assumed the example's thin, RANDOMLY placed
circle outlines would cross it. Probe the area the content can be in, not a point.) **Heatmap layers are always reported as
"visible"** to feature-level queries; MapLibre has no equivalent paint rule for a heatmap's rendered
intensity, and this is a documented, deliberate gap rather than an oversight — `toHaveLayerPixels` is
the honest check for a heatmap layer.

When the evaluator encounters something it cannot resolve — a style expression newer than the bundled
evaluator's grammar — the answer is always **"visible," never a false "invisible."** This is stated as
a hard rule because the alternative failure mode (silently reporting a real, visible feature as hidden)
would be far more damaging to a test suite than the reverse. One subtlety worth recording: an
unrecognized operator inside an expression array does not throw by default — `['some-unknown-op', 1]`
parses as an ordinary literal array rather than raising an error — so the "cannot evaluate" case had to
be detected explicitly (checking whether an array-shaped, non-array-typed paint value is actually a
compiled expression), rather than relying on a `catch` that would never fire. A feature that exists in
an application's data but is not drawn for a library-specific reason distinct from ordinary invisibility
— most commonly, its style references an icon image name that was never added to the map's sprite — is
reported as exactly that in diagnostics, rather than left indistinguishable from an ordinary
symbol-collision hide.

**A failure explains the invisibility: property, value, expression branch, zoom.** "`fill-opacity` evaluates to 0"
tells a user *what* hid a feature, not *why* — in a real style the answer is buried in a `match` on a property or a
`step` on zoom. So a failure message traces it: `fill-opacity is 0 because the match on ["get","kind"] took its fallback
for kind="park"`, at the zoom it was evaluated at. The adapter hands the engine plain data across the seam
(`StyleCause`: layer, property, value, zoom, and the branches taken, outermost first), and the engine words it. The
attribution does not re-implement the evaluator: it walks the property's style JSON and asks MapLibre's evaluator for
every value it needs (the input of a `match` / `step` / `interpolate`, each condition of a `case`, each argument of a
`coalesce`); choosing the branch from those values is the operator's one documented rule, and the choice is *checked* —
MapLibre also evaluates the chosen branch's output, which must equal the value of the whole, or the attribution stops and
only property and value are reported. Covered: `match`, `case`, `step`, `interpolate` (and `-hcl`, `-lab`), `coalesce`,
nested, and legacy `{ stops }` functions through the style-spec's own `convertFunction`. Not traced (property + value
only): `let` / `var`, arithmetic and every other operator, and an interpolation strictly between two stops (both stops are
named; no single branch produced the value). A layer the style does not draw at all is explained the same way: zoom
below `minzoom` or at / above `maxzoom` (MapLibre's own rule), or layout `visibility` "none" — which since MapLibre 5.16
may be an expression on global state, evaluated with the style-spec's visibility evaluator. The explanation is computed
only when something has failed; the visibility verdict never pays for it. Writing this found a real bug: the pixel probe
restored a layer with the constant `"visible"`, replacing a `visibility` expression and turning on a layer the app had
hidden; it now puts back what was there.

## Globe and terrain

**MapLibre's own viewport queries are measurably wrong on a globe projection**, in both directions, as
verified directly against a real globe example at a middle zoom level on version 6.10: a plain
viewport query with no geometry, and an equivalent full-viewport bounding-box query, both returned 24
countries; a point-by-point query at the same view found 83; and a smaller bounding box returned 187 —
because bounding-box queries on a globe include geometry on the *far side* of the sphere along with
whatever is actually visible. For fill-extrusion layers specifically, bounding-box queries on a globe
returned nothing at all, while point queries against the same view found real hits. The workaround,
built entirely from public API: query a 4×4 grid of smaller boxes across the viewport instead of one
large box, and keep only the pieces that have at least one vertex on the *near* side of the globe
(using the round-trip check described next); extrusions specifically are found by a point sweep
combined with their source footprints, since box queries cannot see them on a globe at all. "A globe" is every
projection MapLibre renders through its globe transform: `globe`, `vertical-perspective`, and a projection
*expression* of zoom (MapLibre 5+); only a type of exactly `globe` was recognised at first, so the other two got the
wrong viewport query. The view state names an expression by what it is at the current zoom. Both the
globe specs assert the underlying MapLibre behavior first, so they will fail loudly and visibly the
day the library's own query fixes the underlying bug, rather than silently continuing to run a
workaround that is no longer needed. A known, accepted gap remains: a small extrusion positioned
between grid points, whose footprint's centre happens to fall off-screen, can still be missed by this
grid-based approach.

**The near-side check itself is a round trip through public projection functions:**
`unproject(project(world))` should return (approximately) the same world coordinate that was put in;
if it does not, whatever is actually drawn at that screen pixel is something else, and the location is
not really "there." This exists because `project()` documentedly answers for locations on the far side
of a globe too — the pixel a place *would* project to if the earth were transparent — so, before this
check existed, clicking a location known to be on the far side of the globe silently clicked whatever
was drawn on the near side instead, with no error at all. That is the worst kind of wrong click: one
that succeeds. The fix generalized immediately to terrain, without any terrain-specific code: a
location hidden behind a mountain ridge fails the exact same round trip, and clicking such a location
is now refused as not on the visible surface, whether the reason is the far side of a sphere or a
ridge in the way.

Where the projection math holds, camera realism otherwise required **no adapter changes at all**:
rotation and pitch tests (concave-polygon clicks, right-clicks at a coordinate, drawing, vertex
dragging, geometry assertions) all pass unchanged, because every candidate pixel is computed through
`map.project()` and verified by MapLibre's own hit test — perspective becomes the map library's
problem, never the testing layer's. On terrain specifically, a click at an exact coordinate on a real
slope lands correctly, and a location hidden behind a ridge is refused by the same round-trip check
described above. Rendering terrain at a steep pitch needs elevation and hillshade tiles all the way to
the horizon, which is far more tile data than the same view needs when flat; on constrained,
GPU-less CI hardware a synthetic elevation fixture generated at a high maximum zoom level could not be
PNG-encoded fast enough for the map to settle within its wait budget at all, and the fixture's maximum
zoom was lowered to a level that still comfortably resolves a few kilometres of ridge terrain (tens of
metres per pixel is more than enough) but generates far less data.

Not covered as of this writing: pitch beyond the point where the horizon itself becomes visible
(would need MapLibre's own maximum-pitch guard respected explicitly) and globe behavior at the poles.

## Waiting and determinism

MapLibre's `idle` event is emitted only from inside the map's own render loop, at the end of a frame,
when nothing is dirty, nothing is pending a repaint, the map is not moving, and the style has loaded.
The direct consequence: **if the map happens to already be idle, a bare `once('idle')` listener never
fires**, because nothing will trigger another render to emit it. `waitForIdle()` is therefore built as
"subscribe to `idle` first, then call the public, synchronous `triggerRepaint()`" — forcing exactly
one frame makes an idle map either fire immediately or, if it was not actually idle, schedule the
render that will eventually make it so. A public `areTilesLoaded()` check is layered on top as a
second condition, belt and braces. All of this uses public API only.

Idle by itself is not, and cannot be, a general synchronization primitive: it has no way to know about
application-level asynchrony. Between a click and the fetch-then-`setData` sequence a real application
handler might run, the map is genuinely idle the whole time — there is nothing wrong to observe. For
that reason, **retrying assertions are the primary synchronization mechanism**, the same
`expect.poll`-style retry that ordinary web-first Playwright assertions use; a map-idle wait alone is
never sufficient on its own for anything that depends on application logic between an action and an
expected result. Each assertion's retry loop does still wait for a bounded map-idle before evaluating on
every poll — idle is the secondary, supporting mechanism, not the primary one — and a verdict of
**absence** (a `.not`, a count, "not visible") is taken only from a poll in which the map WAS idle, or was
diagnosed as one that never becomes idle (below). Presence needs no such care: a feature that is found is
there. The first version waited for that idle and ignored its answer: with a GeoJSON source whose data
arrived after 2.5 s, `.not.toHaveFeature` passed after half a second, on the half-loaded map, and the
feature appeared a moment later. The bounded wait grows (0.5, 1, 2 s) only while an absence verdict is what
the assertion is waiting for, so that a slow page gets enough frames to be recognised as never idle; on an
idle map it costs nothing, and a positive assertion waits no longer than before.

A poll that cannot be decided is neither true nor false. The map is not registered or was removed (MapLibre
answers a feature query on a removed map with nothing at all), a named layer does not exist (a typo), the
query matches several features where exactly one is required, the map has not settled, the camera is moving
(`toHavePopup`): such a poll never ends the retry loop, and if the last poll at the deadline was one of them the
assertion fails in **both** polarities and says why — the rule `toHaveView` already had for a map that never
came to rest. Before, "could not look" read as "absent", and each of these `.not` assertions passed.

Some real applications intentionally never idle at all — a `requestAnimationFrame` loop that replaces
`setData` every frame, a streaming line, an always-animating canvas source. An explicit
`waitForIdle()` call against such a map is a trap: it will simply time out. The error therefore says WHY, as far as
public API can tell: an animated canvas or video source (read from the style — independent of frame rate), a source
whose data the application keeps replacing (counted `sourcedataloading` events: OBSERVED, not inferred — a first
version inferred a `setData` loop from "a GeoJSON source is pending and frames are rendered" and blamed one on an
application that was merely loading slowly on an overloaded machine; a wrong diagnosis is worse than none), continuous
repainting with nothing loading, tiles still loading, or a moving camera.
Assertions are unaffected, since their own idle wait is bounded rather than blocking, and the same diagnosis
(an animated source, a source re-set in a loop, continuous repainting — never "still loading", "moving" or "slow")
lets a negative verdict be taken on such a map without idle; only an explicit, unconditional wait for idle needs
to be opted out for a map like this.

**Timeouts mean what they say.** `waitForIdle()` defaults to two thirds of the test's timeout: the first idle after a
navigation is a load — style, sources, tiles, first render — and Playwright bounds loads by the test timeout only.
Measured on five third-party apps: 1.7–2.2 s to the first idle alone, 4–9 s with five parallel software-GL workers on a
busy machine; the earlier 10 s budget failed exactly where CI is slow. The default action timeout is a third of the test's timeout (at least 10 s) and is
read when used, so `test.slow()` scales it — a page that is slow enough to need `test.slow()` needed every geowright
timeout raised by hand before. And an action's `timeout` is wall-clock: a side-effect-free round trip into a busy page
(finding the pixel) is abandoned at the deadline — measured before: 33 s for `{ timeout: 2000 }` on an overloaded
machine. Real input is never abandoned half-way. What follows a failure is bounded too: on a page that stopped
answering, the map state and the screenshot are skipped (they would wait for it: `click({ timeout: 1000 })` on a page
blocked for 5 s returned after 5 s, now after 1 s); otherwise they get 2 s. An action with several points (a drag, a
shape) has one timeout for all of them, not one each. A round trip is never abandoned before it has had 500 ms: a last
attempt that started with a few ms left used to be abandoned for want of them, and the timeout then blamed "a busy main
thread" on an idle page instead of the real reason (the slowest round trip measured: 206 ms, on the dense page at 4x
CPU throttling). As in Playwright, `timeout: 0` means no timeout.

**The library has no fixed sleep of its own, and neither do its tests.** The one that used to exist — a
short pause between vertices while drawing a shape, to avoid an unintended double-click — turned out to
be unnecessary: CDP-dispatched mouse events carry an explicit click count, so two fast clicks at
different pixels are never mistakenly treated as one double-click regardless of timing. Once that was
understood, the pause was removed rather than tuned. What remains is a pause a caller asks for: `draw.polygon` /
`draw.line`'s `vertexDelay` (default 0), for a draw tool of the app's that debounces clicks.

**No network reaches the outside world during a test.** Style, GeoJSON sources, and raster tiles are
all served from in-memory fixtures through `page.route`; vector tiles are cut from a GeoJSON fixture on
the fly, inside the route handler, using the same tiling libraries a real tile pipeline would use
(`geojson-vt` + `vt-pbf`), so the application's real `{z}/{x}/{y}.pbf` request path runs against
deterministic, generated tiles rather than a mocked response shape. The test fixture harness treats
any request it cannot answer as a hard failure, aborting it and failing the test with the offending URL
named — which doubles as the mechanism for discovering exactly what a newly tested application needs
before it will finish loading.

Headless rendering runs with the same software-GL flag set MapLibre's own upstream test suite uses in
its own continuous integration: GPU acceleration disabled, with SwiftShader's unsafe and
software-GL-fallback flags enabled so WebGL still renders correctly without a real GPU.

The project's flake bar is `--repeat-each=20` with **zero retries configured anywhere** — a failure is
a failure, not something a retry is allowed to paper over. Run to a clean, quiet result, that bar has
caught real, load-independent bugs rather than timing noise: the line-candidate ranking bug described
under actionability; a `.not.toHaveView()` matcher that could be satisfied merely by the map still
being in motion (visible only on a slower rendering pipeline, since a fast one had usually already
finished its ease-out by the time the check ran — fixed by requiring the camera to be genuinely at
rest in both the affirmative and the negated form of the check); and the animated-source identity edge
case described under identity. It also catches flaws in the tests themselves: two wild-example specs
that could fail on a timing or geometry chance (keyboard zooms pressed faster than the map settled; a
pixel probe covering only a quarter of an animated canvas) were each reproduced in isolation on a quiet
machine and fixed before the suite was counted. The complete suite as it stood on 2026-09-24 (349 tests,
plus 13 that are opt-in and skipped) passed **6,980 of 6,980 at `--repeat-each=20`, zero flakes, zero
retries**, in 56 minutes — the machine's load was logged once a minute through the run, and a number
is only written here once the machine has produced it without other heavy work, or with only more load
than a quiet machine (which can cause a failure, never a pass). The same commit passed the full suite
and the compatibility matrix on Linux in the official Playwright container. The earlier suites passed
the same way: 312 tests 6,240 of 6,240 in 50 minutes on 2026-09-23, 304 tests 6,080 of 6,080 in about an hour at the end of 2026-09-21, 299 tests 5,980 of
5,980 in 50 minutes on a quiet machine the same day, 277 tests 5,540 of 5,540 the day before. The same suite has
also been run through hosted Linux continuous integration (software rendering, no GPU, few CPU cores),
which is measurably slower — the base suite alone runs in on the order of 20 minutes there versus about
two and a half minutes locally — and which found two more, purely hardware-driven issues invisible on a faster
machine: a terrain test whose elevation fixture could not be encoded fast enough to let the map settle
within its timeout (addressed by the reduced maximum zoom described under terrain), and a
high-device-pixel-ratio mobile emulation test that rendered close enough to its timeout to occasionally
cross it under software rendering, addressed by giving that specific test a longer allowance.

## The agent layer: text snapshot and accessibility mirror

A browser-driving agent gets essentially nothing from a page's accessibility tree where a MapLibre
canvas sits: an empty, unlabelled region. Two ways to fix that were built, both delivered the same way
the rest of the library is delivered — an injected script, no custom protocol server required.

**A text snapshot** is a compact, structured description of the map: the current view and bounds,
each layer with whether it currently has content, is empty, or is hidden (plus its source type), and a
list of entities. Design rules, in order of what mattered most in practice:

- Related layers are folded into one entity line (a circle, its label, and its outline, presented as
  one thing under its primary layer) rather than listed three times.
- Every listed entity carries a pixel that has been *verified* clickable by the same actionability
  machinery real actions use — or, if none exists, a reason why not (covered by another feature,
  covered by DOM, or off-screen) — rather than a geometric guess that might not actually be clickable.
- Entities are ordered nearest to the view centre first, and the whole list respects a character
  budget (a few thousand characters by default): the per-layer cap shrinks progressively until the
  snapshot fits, hit-test results are cached so shrinking costs nothing extra, and a hard cut with an
  explicit notice is the last resort if nothing else fits. What survives the cut is individual rows,
  never the summary counts or the value histogram of what did not make the cut — the histogram
  deliberately covers the *whole* layer, not only the truncated remainder, so nothing has to be added
  together across two different lists to get an honest count. (That holds for the app's layers; a large
  basemap's histograms go earlier, in the stages described next.)
- A basemap — a tiled source with eight or more layers on it — is the least interesting part of a snapshot
  of an app, so it gives up its budget first. Giving up its *rows* turned out not to be enough: on a
  production-sized style (80–120 layers, 25+ of them with content in view) the row-less sections and the
  layer ids in the header alone filled the default budget, and the app's own layer was left with no rows
  (the real OpenFreeMap style: 0 of 1,025 buildings). So the basemap degrades in stages, each tried only if
  the previous one does not fit: no rows; one shared note on how to list a basemap layer
  (`snapshot({ layers: [...] })`) instead of a hint per layer; the header lists count its layers per source
  instead of naming them (in the top-to-bottom list each run of them is counted in place, so an app layer
  inserted under the basemap's labels is still seen to be under them); one count line per layer, without
  colour or histogram; one line per source naming its layers with entity counts; that line counting layers
  by type only. Only then does the app's own per-layer cap shrink, and if it had to, the basemap gets back
  whatever room that freed. The snapshot always still says that there is a basemap, how big it is, what
  kinds of layers it has, and how to ask for more. App layers keep their line shapes at every stage.
  Telling the app's layers from the basemap's uses only what every adapter reports (source, source type,
  layer type): a layer the app adds to the basemap's own source — MapLibre's 3D-buildings example extrudes
  the basemap's building footprints — is recognised by being the only layer of its type there, since a
  basemap draws each kind of thing with a family of layers. An app layer of a type the basemap already
  uses on that source (a highlighted road, say) is still taken for basemap; naming it in `layers` fixes that,
  since layers asked for by name never count as basemap.
- A `filter` option narrows the listing to entities matching a query — the tool for finding one entity
  among thousands of look-alikes without reading the whole layer.
- For layers backed by a GeoJSON source, the snapshot can additionally report what exists but is
  currently outside the viewport, with a compass direction toward it, and what is inside the viewport
  but not drawn as an individually addressable thing (clustered, or hidden by symbol collision).
- The evaluated paint color for a feature (or for a whole layer, when the color is not data-driven)
  is included, specifically so a question like "which one is drawn red" can be answered from the
  snapshot text rather than requiring a screenshot.

**An accessibility mirror** takes a different approach: it places one invisible, real `<button>`
element per entity inside the map's own DOM container, at that entity's verified clickable pixel, and
reconciles those buttons by the same entity identity key used elsewhere so they survive across
re-renders. An ordinary accessibility snapshot then lists these buttons with descriptive names, exactly
like any other page control, and an ordinary click on one is a genuine click that bubbles into the map
precisely as a click on a real DOM marker would. This mirrors an idea used by Flutter's web renderer,
which maintains a parallel, hidden DOM "semantics" tree specifically so accessibility tooling can
interact with canvas content it otherwise cannot see. The mirror needs no special instructions for an
agent to use it, since it looks like an ordinary accessible page — but it has real costs: it mutates
the application's own DOM (so it has to be excluded, deliberately, from the ordinary DOM-cover check
used by real actions, and it stays off by default outside agent-specific runs), it only updates when
the map reaches idle, so it can go visibly stale during an animation, the invisible buttons can
intercept hover from whatever is genuinely underneath them, and a dense map needs an explicit cap on
how many buttons get created.

A handful of short, directional comparisons (single runs per condition, not a statistically meaningful
sample, and reported here only as evidence for a design choice rather than as a benchmark) informed
which of these two approaches, if either, is worth defaulting to. Given only ordinary browser
automation tools and a short map-specific task, an agent given the text snapshot plus a short amount
of guidance completed every task correctly using noticeably fewer tool calls and less context than an
agent with only ordinary tools and vision. A vision-capable agent with no map-specific help at all was
not helpless on a small, sparse map — it usually found the right pixels by looking — so the value of
the structured view there was efficiency and completeness (naming things, like road or station names,
that are never actually rendered as separate labels a vision-only agent could read), not the raw
ability to finish the task. The gap widened sharply on a dense map with thousands of overlapping
points and shapes: the snapshot-driven agent still completed every task; a vision-only agent completed
only one of five, and for several of the others success was impossible for *any* vision-only approach
by construction, since the requested attribute (a serial number, a zone, an owner) is never drawn
anywhere and the page under test had no popup to reveal it on click. The one genuinely apples-to-apples
comparison was a counting task: reading an overlapping pile of dots by eye undercounted the true total
by roughly a factor of three and a highlighted subset by roughly a factor of five, while the structured
snapshot read both numbers correctly off a single line. The accessibility mirror, in the same set of
comparisons, needed no instructions at all but was the slowest of the working approaches, because the
browser-automation protocol used in these comparisons no longer inlines the accessibility snapshot
into every response — an agent has to think to go look at it, and tended to reach for a screenshot
first instead.

One direction considered but not usable at the time of writing: letting a page register its own tools
for an agent to discover directly (the emerging `navigator.modelContext` web API), which would be the
most direct integration of all. The API was not yet implemented in the browser versions tested against.

## Testing apps we did not write

Every test described above validates the library against its own demo application, written with the
library's own assumptions baked in from the start — which is exactly the bias worth removing before
trusting the design. A separate suite instead targets applications nobody working on this library
wrote: MapLibre's own official examples, and small applications built by others on top of community
wrapper libraries around MapLibre (React, Svelte, and Vue).

Every one of these applications is vendored as **upstream plus exactly one added line** — the same
one-line registration hook described earlier, and nothing else. For the official examples a script
diffs each vendored copy against the pinned upstream release tag (fetched once and cached) and
confirms the diff is exactly one added line, the hook, for every example; the committed diffs are
checked again by the unit suite without the network. The wrapper applications record the exact
upstream commit and their one line; the unit suite checks that each app's sources hold exactly that
line, once per vendored file, and nothing else naming the hook — that the rest of each file is
upstream's was checked by hand when it was vendored, not by the suite. Nothing in any of these
applications was bent to fit the testing library: where something was awkward, the library's own
adapter changed, or the friction was written down as a known limitation — never the vendored
application. No network reaches outside these tests either; a routing layer answers everything each
application fetches, and an unanswered request fails the test naming the URL, which is also how a
newly vendored application's missing fixtures get discovered in the first place.

**Real basemaps could not simply be copied into the repository, and this was treated as a design
constraint rather than an inconvenience to route around.** A large share of these examples use a
basemap built from OpenStreetMap data — OSM's own data license (ODbL) imposes share-alike obligations
on anyone redistributing it, and a common cartographic *design* built on that data ("OSM Bright" and
its derivatives) is separately licensed CC-BY, requiring attribution that a bare test fixture would not
carry correctly. Others use commercial vendor tiles under proprietary terms. None of that can be
committed as a plain binary fixture in good conscience. One basemap genuinely can be, and is: a small,
recorded extract of `demotiles.maplibre.org`, whose data (Natural Earth) and style are both
permissively licensed (BSD-3-Clause). Every other basemap an example needs is instead **synthetic but
contract-faithful**: the same request URLs, the same source and source-layer names, the same layer ids
an example's own code refers to, a real sprite and glyphs, built around a generated dataset (a small
synthetic city — a street grid, buildings with heights, a lake, a park, points of interest, and labels)
cut into genuine vector tiles on the fly. A terrain elevation fixture is likewise a synthetic ridge,
encoded as real elevation-tile imagery. Nothing about the *code path* under test is faked — only the
geographic content is invented, which is the one thing licensing actually restricts. This buys a
legally uncomplicated fixture at a real cost in realism: a synthetic basemap has on the order of twenty
layers where a real basemap style commonly has well over a hundred, and label density is correspondingly
much lower — occlusion caused by dense basemap labelling, expected going in to be a significant source
of friction, was as a result barely exercised. That was the first synthetic basemap; the one the suite uses now is
label-dense (next section).

### Label realism

The synthetic basemap first got an opt-in `dense` variant — 71 layers, 21 label layers, about 340 labels in view, all
generated — for one question: what happens to an application's features when basemap labels are drawn ON TOP of them,
which is where an application that inserts its layers below the labels (the usual advice; MapLibre's 3D-buildings
example does it) actually lives. Of 60 buildings, 40 were clickable at their best pixel and 19 only at another one,
because a house number, a point-of-interest name, a street name or a neighbourhood label covered the best; every click
landed on the building that was asked for — after the whole-pixel fix described under actionability, which this
fixture is what found.

The dense basemap is now the DEFAULT for every wild app that loads a synthetic OpenFreeMap, MapTiler or CARTO style,
and it is dense at every zoom those apps use, not only up close: around the city core lies a generated region
(suburbs, villages and towns every few kilometres, arterial roads with names and route numbers drawn as road shields,
motorways, rivers, lakes, parks, stations, bus stops, airports; cities, states and countries further out), under a
79-layer style with 24 symbol layers. Measured the same way on both — basemap symbols MapLibre actually placed in the
same 880×720 px window — the synthetic basemap renders 75, 42, 50, 93, 240 and 171 labels at zoom 11 to 16, the real
OpenFreeMap style 59, 26, 35, 78, 239 and 130, and the sparse city it replaced 5, 5, 6, 10, 33 and 25. A spec keeps
it within 0.6–2× of the real numbers at each zoom. The density found a library limitation at once: on a basemap this
size, `snapshot()` keeps a section for every basemap layer in view and runs out of budget before the application's own
layer gets a single row (9 app symbols, 0 listed; on the real style, 0 of 1,025 buildings). It is pinned down by a
spec marked as a known failure until the budget is fixed.

A REAL basemap is available too, but only on a developer's own machine: a script caches a small OpenFreeMap extract
(OpenStreetMap data, ODbL) outside the repository — never committed, never in CI — and an opt-in spec set runs the same
example against it, still without touching the network. 120 layers, 25 label layers, ~300 labels and 1,025 real
buildings in view: 25 buildings → 19 clicked on target (9 of them at a pixel other than the best one, under transit and
street labels or behind a neighbour), 4 honestly occluded, 2 off-screen slivers. Real data found what generated data
could not: the floating building parts mentioned under actionability.

### Scoreboard

33 applications not written for this project — 23 official MapLibre examples, 3 React (react-map-gl)
applications, 1 deck.gl MapLibre React application, 1 Protomaps PMTiles application,
2 Svelte (svelte-maplibre-gl) applications, and 3 Vue (vue-maplibre-gl) applications —
covering 135 specs in total (`tests/wild` holds 147: the other 12 are the dense-basemap, label-density and opt-in
real-basemap realism specs, which are not apps):

| app | specs | result |
|---|---|---|
| create-a-hover-effect | 3 | after a library fix (bounded search; verified action point; feature state) |
| create-and-style-clusters | 4 | untouched |
| display-buildings-in-3d | 4 | after a library fix (fill-extrusion lift) |
| 3d-terrain | 5 | after a library fix — of the snapshot only; every action was already right |
| create-a-heatmap-layer | 5 | untouched (heatmap is always "visible": documented, by design) |
| filter-within-a-layer | 5 | untouched — and the upstream example itself is broken; the specs pin that down |
| show-polygon-information-on-click | 5 | untouched |
| select-features-with-boxzoomend-callback | 5 | after a library fix (drag modifiers) |
| filter-symbols-by-toggling-a-list | 5 | after a library fix (id-less identity; missing-icon message) |
| filter-symbols-by-text-input | 4 | after a library fix (id-less identity) |
| variable-label-placement | 4 | untouched; needs an extended timeout for the example's own animation |
| display-a-popup-on-click | 6 | after a library fix (id-less identity; property-identical look-alikes) |
| center-the-map-on-a-clicked-symbol | 4 | after a library fix (id-less and property-less symbols) |
| animate-a-point | 6 | untouched, with a real limit: a perpetually moving point is refused by default (later: `{ moving: 'allow' }` clicks it) |
| update-a-feature-in-realtime | 5 | untouched (the map never idles by design) |
| add-a-canvas-source | 5 | after a library addition (`toHaveLayerPixels`) |
| animate-a-series-of-images | 4 | untouched (a pixel assertion on it was removed: under load the app itself paints nothing for seconds) |
| create-a-draggable-point | 5 | untouched |
| measure-distances | 5 | untouched |
| draw-polygon-with-mapbox-gl-draw | 2 | untouched library; the fixture (a bundled third-party dependency) was the hard part |
| draw-geometries-with-terra-draw | 6 | untouched |
| display-a-globe-with-a-vector-map | 5 | after a library fix (globe viewport query) |
| display-a-globe-with-a-fill-extrusion-layer | 6 | after a library fix (globe extrusion query) |
| react-map-gl / controls | 4 | untouched (React-rendered markers and popups) |
| react-map-gl / geojson | 4 | after a library fix (snapshot colour reporting) |
| react-map-gl / filter | 5 | after a library fix (nested property values in the snapshot) |
| deck.gl / MapboxOverlay React | 2 | untouched; custom deck layers share the MapLibre canvas, while the MapLibre buildings remain addressable |
| Protomaps / PMTiles MapLibre | 1 | untouched; a synthetic PMTiles v3 archive is loaded through the app's custom byte-range protocol |
| svelte-maplibre-gl / hover-styles | 3 | after a library addition (querying by layer type / source) |
| svelte-maplibre-gl / clusters | 3 | after a library fix (a map positioned below the fold) |
| vue-maplibre-gl / filter | 2 | after a library fix (world copies) |
| vue-maplibre-gl / geojson | 1 | untouched |
| vue-maplibre-gl / marker-popup | 2 | untouched |

**33 apps, 135 specs (re-counted against `--list` on 2026-09-22). Worked untouched: 17 (52%). Worked after a library fix or addition: 16 (48%).
Could not be tested at all: 0.** That zero deserves its caveats stated alongside it, honestly: some
applications were excluded before ever being tried, purely on licensing grounds (one video-based
example with no license found for its video asset; anything that would otherwise need real OSM or
commercial vendor tiles ran against the synthetic basemaps described above instead). And every fix
behind the 48% figure was made by people who could see both the failing test and the library's source
at the same time, on the same day — an outside team hitting "three markers silently counted as one" or
"hovering does nothing on a map positioned below the fold" would more plausibly have filed a bug, or
given up, than fixed the library themselves. The honest reading of this scoreboard is not "0% failure
rate"; it is that roughly half of unmodified real applications exposed a real gap, which is a
reasonably direct measure of how much bias toward the project's own demo application this exercise
removed.

**Library changes this forced**, each backed by a dedicated spec or unit test: lifting fill-extrusion
action points toward the roof and walls; splitting id-less, property-identical features by on-screen
contact, plus the world-copy and re-rendering-generation fixes for the same identity problem; bounding
and re-ranking the candidate search so a large, mostly-covered shape stays fast; correcting the
resolved-feature coordinate to be the *verified* action point rather than an unverified geometric
guess; no longer treating an invisible feature as an occluder; the globe viewport-query workaround;
honoring input modifiers (such as a held Shift key) during drag gestures; querying layers by their type
or source rather than only by id, for wrapper libraries that generate layer ids programmatically;
scrolling a map positioned below the fold into view before acting on it, rather than silently acting on
the wrong screen location; `toHaveLayerPixels` for layers with no individually addressable features;
better handling in the snapshot for nested property values, layers with no features to be "empty of,"
terrain and projection state, evaluated color, and per-feature state; and naming a missing icon image
explicitly rather than leaving it indistinguishable from an ordinary label collision.

**What needed no library change at all** is worth recording alongside the fixes, since it is just as
informative: clustered sources with no feature ids of their own; feature-state-driven hover styling;
framework-rendered markers and popups (found correctly by location, with popups correctly anchored); a
map registered later than the very start of the test, once a wrapper's own load callback finally fires
(an ordinary retry against "no map registered yet" handles this with no special case); application-level
asynchronous data flow (fetch, then compute, then update the map's data — ordinary retrying assertions
simply wait it out); and terrain in general, where the globe's near-side round-trip check turned out to
already be exactly the right check for "is this point hidden behind a ridge," with no terrain-specific
code needed.

## Version compatibility

The adapter was written against MapLibre GL JS 6, but most production applications run an older major,
and many still run Mapbox GL JS v1 (BSD-licensed up to 1.13; v2 and later are proprietary and are
deliberately neither installed nor tested). A version matrix runs one small page and one core set of
specs — assert, act, occlusion, visibility, pixel probe, snapshot, markers and popups, vector tiles,
camera and geometry, off-screen source data — against Mapbox GL JS 1.13 and MapLibre 2, 3, 4, 5 and 6,
installed side by side under npm aliases. It has its own Playwright config and CI job so that it cannot
slow down the flake bar of the main suite.

On first contact 50 of 54 tests passed; the API family is that stable. What the four failures taught:

- **Feature-detect, never version-sniff.** `getLayersOrder()` (MapLibre 3+) falls back to the layer list
  of `getStyle()`; `GeoJSONSource.getData()` (4+) falls back to `serialize()`, which echoes what the
  application passed in — the data object, or only its URL, in which case off-screen features are as
  unknowable as for a tiled source, and the adapter says so; `getProjection()`, `getGlobalState()`,
  `getTerrain()` are optional calls. Marker and popup CSS classes are `mapboxgl-…` on the v1 family.
- **The pixel probe without `redraw()`.** Mapbox GL JS v1 has no public synchronous render. The same
  read-back works inside the public `render` event, which fires in the task that drew the frame:
  `triggerRepaint()`, read on `render`, hide the layer, repeat. That costs three REAL frames, and the
  frame without the layer can reach the screen (a one-frame flicker) — so the seam method may now
  return a promise, and an adapter on such a version lists the difference among its caveats.
- **A matcher bug only an old version could show.** `toBeVisibleOnMap()` assigned its verdict after
  the paint check and again after the pixel probe; when the probe THREW (no `redraw()`), the paint
  check's "visible" was left standing and the matcher passed at its deadline without ever having looked
  at a pixel. The verdict is now assigned once, after every check has run, and an exception is a "no".
  A capability that silently degrades is the failure mode to fear in a version matrix; this was one.

What an old version cannot do is reported by the adapter's `caveats()` — printed once in failure
diagnostics and in the snapshot — never answered with a guess. The bundled style-spec evaluator being
NEWER than an old style is harmless (old expressions are a subset); the reverse case is the
unsupported-expression caveat described under visibility. Globe, terrain, touch, drawing tools and the
third-party applications are exercised on MapLibre 6 only; the support table in the README says
"not in the matrix" for them rather than "✓".

## Costs and known limitations

Measured on a quiet machine (single test worker, software rendering, medians of repeated runs), against
a dense stress page holding roughly 3,240 point features and 415 polygons in view at once:

| operation | cost |
|---|---|
| find (match) 3,240 point features | 20 ms |
| find 415 polygon features (grid-of-candidates each) | 14 ms |
| find with a property filter (narrowing to ~20 matches) | 9 ms |
| find with paint-visibility evaluation across all 3,240 features | 15 ms (~5 ms attributable to the evaluation itself) |
| resolve one action point (includes the two-frame stability wait) | 33 ms |
| build a full text snapshot | 49 ms |
| build entity list for the accessibility mirror (capped at 80) | 43 ms |
| pixel probe, warm | 25–27 ms |
| globe: full-world initial idle | 2.4 s |
| globe: click near side / refuse far side / build snapshot | 14 ms / 1.07 s / 70 ms |

At these costs, hit-test-based candidate search was, against an early expectation to the contrary,
never actually the bottleneck for a dense map — a single point query costs a small fraction of a
millisecond, and several thousand of them together still land well under 100 ms. The real cost of
density turned out to be correctness (features with no reachable pixel at all), not speed, which is
why the ring-candidate mechanism described under actionability exists.

The injected in-page script grew from roughly 22 KB to about 410 KB (not minified; 88 KB gzipped, 200 KB if it were
minified — measured on the 0.1.0 build) once the bundled MapLibre style-spec evaluator (used for paint-visibility
checks) was added, injected once per page load. This is a real, deliberate size-for-correctness trade, and it carries a version-coupling
risk worth stating plainly: an application on a MapLibre release newer than the bundled evaluator,
using a style expression the evaluator does not recognize, will silently fall back to the safe-but-
weaker answer described earlier ("visible," never a false "invisible") rather than failing outright.

**What is still wrong, as of this writing:**

- `hover({ moving: 'allow' })` is only dependable when a frame of the page is short compared with the time the target
  spends under one pixel; `click` holds up under contention, hover does not (a `mousemove` is frame-aligned).
- On a page that stalls, the default refusal of a moving target is not absolute. When the renderer (and, for a GeoJSON
  source re-set every frame, its worker) is starved, two consecutive frames can show a perpetually moving feature at the
  same pixel; the stability check then passes and an action goes out without `moving: 'allow'`. Seen once, on Linux in
  a container at a load of about 30 with other CI jobs on the machine: `hover()` on MapLibre's "animate a point" was
  delivered onto the pixel where the point was drawn at that instant. Nothing else was hovered, and `click` stays
  protected by the click-time check, but a `hover` has no such check. "Same pixel over two frames" is too weak a
  definition of "at rest" for a source that changes every frame; a stronger one is planned.
- A target moving faster than roughly its own diameter per input latency cannot be clicked at all; the action times
  out honestly (every late press is swallowed), it does not mis-click.
- A `moving: 'allow'` click is verified at `pointerdown`, but MapLibre attributes a click to a layer on the DOM `click`
  event, after the release, by querying what is drawn then. The press and the release are separate round trips to the
  browser; on a page that re-sets its source every frame, a frame drawn in between can move a small dot off the pointer.
  The action then reports success and the app's click missed the target: it landed on whatever is drawn under it (on
  that page, no feature). Seen once in 21 runs of MapLibre's "animate a point" at a load of 12–30; 20 of 20 when re-run
  alone. The planned fix re-checks at `click` too, and reports a miss
  there as a failure after input: the input was sent and is never sent again.
- Identity disambiguation by asking the source only works for GeoJSON sources; a vector-tile source cannot be asked.
  (A rare "ambiguous instead of unstable" on MapLibre's animated point had a plain cause: its source holds a bare
  GeoJSON geometry, which was read as "no features", so nothing could be learnt from it. Fixed; the statistical
  confirmation under contention is still owed.)
- Two id-less, property-identical shapes that visually touch on screen are still treated as a single feature.
- Pixel-only layers (raster, image, video, canvas, heatmap, hillshade, …) drawn ABOVE a feature are checked by a pixel
  probe of the feature's layer at the chosen pixel (Actionability, item 4). What that costs and misses:
  - one probe per action on a map with such a layer over its features (four renders: ~15–45 ms on a quiet Mac by
    version, more under software GL on Linux), up to three when candidates are covered; none without one.
  - on Mapbox GL v1 the probe renders real frames: the one without the layer can be seen (a one-frame flicker).
  - where the target's opacity is data-driven, the probe reloads its source and the action waits for it to come back.
  - the verdict threshold is the probe's: any difference counts as "shows through", so a 97%-opaque veil lets the
    click through.
  - the press-time check sees only a pixel-only layer that was not over the target at the aim; new pixels inside an
    overlay that was already there (the next radar frame filling a gap) between the aim and the press are not checked.
  - `moving: 'allow'` is not checked at all: a moving target's pixel changes between a probe and the press.
  - on MapLibre >= 5 a heatmap is hit-testable over its whole radius, so there a heatmap above a feature occludes it
    through the hit test, faint fringe included (not checked at runtime yet).
- The globe query workaround is a grid-based heuristic: an extrusion narrower than 16 px whose footprint centre is
  off-screen or on the far side can be missed by viewport-wide queries (never mis-clicked; a query `at` it finds it).
- A zoom-and-data paint expression on a view whose tile zooms vary (terrain, high pitch, globe) is judged "visible"
  where some tile zoom draws it: an uncertain verdict, said in the caveats, not a confident one. `within` / `distance`
  in paint cannot be evaluated at all (visible, with a caveat).
- The version matrix covers the core on six versions; globe, terrain, extrusions, touch, drawing tools and the
  third-party applications run on MapLibre 6 only.
- Real-basemap realism exists only as an opt-in, local cache: no real basemap data can be committed under the
  repository's permissive-licenses-only rule.
- Drawing tools have not been exercised under touch input.
