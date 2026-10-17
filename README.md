# geowright

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Grey-box testing for canvas maps in Playwright. First adapter: MapLibre GL JS 2–6 and Mapbox GL JS 1.13 ([support table](#supported-map-library-versions)).
Early (0.x): the API may still change. Design decisions, the evidence behind them and honest caveats: [docs/DESIGN.md](docs/DESIGN.md).
Tested against third-party MapLibre examples and react-map-gl / Vue / Svelte wrapper apps in [`wild/`](wild/README.md); the scoreboard is in [docs/DESIGN.md](docs/DESIGN.md).

Closes two gaps a DOM-only Playwright suite has on a WebGL map:

- **ASSERT** — after an action in the normal UI, verify something was added to / changed on / removed from the map.
- **ACT** — perform actions that start on the map: click a feature, right-click a location, draw, drag a vertex.

Actions are **real input** (`page.mouse` at projected pixels), never `map.fire()`. The adapter uses MapLibre's **public API only**.

## Start

```sh
npm i -D geowright @playwright/test && npx playwright install chromium
npx geowright init      # a fixture, the software-WebGL flags (+ a whole playwright.config if you have none), a first spec
                        # that prints map.snapshot(), and the hook for your wrapper
```
More: [docs/RECIPES.md](docs/RECIPES.md).

A CommonJS TypeScript project (no `"type": "module"`)? geowright is ES modules only: under `"module": "node16"` or `"node18"` tsc rejects `import … from 'geowright'` with TS1479 (the tests still run). In the tsconfig that checks your tests, set `"module"` to `"nodenext"` (TypeScript 5.8+), `"node20"` (5.9+), or `"commonjs"` with no `"moduleResolution"`.

## App side: one line, no dependency

<!-- example: skip (app-side code: it runs in your app, not in a test; `{ ... }` stands for your map options) -->
```ts
const map = new maplibregl.Map({ ... });
(window.__geowright_maps ??= {}).main = map;   // that's it; nothing is imported, nothing ships
```

Keep that line out of production builds (`if (import.meta.env.MODE !== 'production')`, or your bundler's equivalent):
it makes the map instance reachable by every script on the page ([SECURITY.md](SECURITY.md)).

In TypeScript, add `/// <reference types="geowright/app" />` to a `.d.ts` file your **app's** tsconfig includes (a Vite
app has `src/vite-env.d.ts`) and the line compiles as written, without `(window as any)`. It is types only: nothing ships.

With a wrapper the map instance arrives in a callback — still one line (all three verified in `wild/apps/`):

<!-- example: skip (app-side component markup with elided props; each line is verified in its wild/apps/ app) -->
```jsx
<Map onLoad={e => ((window.__geowright_maps ??= {}).main = e.target)} … />              // react-map-gl
<MapLibre onload={(e) => ((window.__geowright_maps ??= {}).main = e.target)} … />      // svelte-maplibre-gl
<mgl-map @map:load="e => ((e.map.getContainer().ownerDocument.defaultView.__geowright_maps ??= {}).main = e.map)" … />
// ^ vue-maplibre-gl: a Vue template cannot see `window`; in <script setup> the plain line works
```

Wrappers fire that callback on MapLibre's `load`, which needs every declared source: if a data request fails, the map is never registered.

The in-page adapter is injected by Playwright at test time. (Auto-discovery is not possible for bundled ESM apps — `tests/discovery.spec.ts` proves it.)

## Test side

Inside a Playwright test, once the page shows your app:

```ts
import { geowright, expect } from 'geowright';

const map = geowright(page);                       // { mapId?: 'main', timeout?, ignoreLayers?, mirror?, failureScreenshots? }
await map.waitForIdle();

// ASSERT — retrying, like web-first assertions
await expect(map).toHaveFeature({ layer: 'alerts', where: { severity: 'high' } });
await expect(map.features({ layer: 'alerts' })).toHaveFeatureCount(3);
await page.getByTestId('alert-remove-2').click();                          // an action in the app's normal UI...
await expect(map).not.toHaveFeature({ layer: 'alerts', id: 2 });           // ...and its effect on the map
await page.getByTestId('toggle-sensors').check();
await expect(map).toHaveFeature({ layer: 'sensors', id: 502 }, { visible: 'any' });  // opt out: "rendered" incl. opacity-0
await expect(map.feature({ layer: 'sensors', id: 501 })).toBeVisibleOnMap();       // paint and pixels
await page.getByTestId('fly-east').click();
await expect(map).toHaveView({ center: { lng: 35.2, lat: 32.08 }, zoom: 12 });     // once the camera is at rest

// ACT — auto-waiting, strict, verified
await map.feature({ layer: 'alerts', id: 4 }).click();
await map.feature({ layer: 'parcels', id: 103 }).click({ autoPan: true }); // off-screen: map's scrollIntoView, opt-in
await map.clickAt({ lng: 34.78, lat: 32.08 });
await map.wheelAt({ lng: 34.8, lat: 32.1 }, -600);                        // zooms around the pointer
```

The examples in this file run as tests against the app in [`demo/`](demo/) (`tests/docs/`): that is where their layer
names, ids and coordinates come from.

### Queries

```ts
import type { FeatureQuery } from 'geowright';

const queries: FeatureQuery[] = [
  { layer: 'alerts' },                                   // string or string[]
  { layer: 'alerts', id: 7 },
  { layer: 'alerts', where: { severity: 'high' } },      // equality
  { layer: 'alerts', where: { name: /^gas/i } },         // RegExp
  { layer: 'alerts', where: { severity: { in: ['high', 'medium'] }, id: { gte: 2 } } },
  //   operators: eq ne gt gte lt lte in matches exists
  { layer: 'td-point', at: { lng: 34.85, lat: 32.04 } }, // only what is rendered under that location
  { layer: 'sensors', visible: 'any' },                  // default is visible only; 'any' = MapLibre's "rendered" (see below)
  { layerType: 'circle', where: { cluster: true } },     // for layer ids generated by a wrapper (svmlgl-layer-0)
  { source: 'earthquakes', layerType: ['circle', 'symbol'] },
];
```

`map.feature(q)` is **strict** (exactly one match, like a Locator); `map.features(q)` is a set.
Handles are lazy: nothing is resolved until an action or assertion runs.

`id` is the id in the app's data. MapLibre keeps a feature id only if it is a non-negative integer and draws any other
(`'north-gate'`, a UUID, `-5`, `1.5`) as some other number, or none: on a GeoJSON source such an id is found through the source's
data (look-alikes drawn with one number are told apart by where they are drawn); on a tiled source it can never match,
and the query is an error that points to `promoteId`. A `where` operand of the wrong kind (`in` that is not an array,
`exists` that is not a boolean, a bound that is not a number, an `undefined` value) is an error too.

### Visible by default

MapLibre's `queryRenderedFeatures` also returns features painted with opacity 0, a transparent colour or zero size — so a
naive "the feature exists" check passes on something no user can see. Here queries match **only what a user can see**: the
layer's paint properties are evaluated for that feature (data-driven expressions, zoom, feature-state), and a failure says
which property hid it (`[NOT VISIBLE: circle-opacity evaluates to 0]`) and why: its value, the expression branch that
produced it, and the zoom (`-> parks#7 is not visible at zoom 11.2: fill-opacity is 0 because the match on ["get","kind"]
took its fallback for kind="park"`). `visible: 'any'` opts out; `visible: false` matches
only the invisible ones. `expect(map.feature(q)).toBeVisibleOnMap()` adds a pixel probe at one point of the feature
(catches a transparent icon image; what one point misses is in [Limits](#limits)). On a map not wholly inside the browser
window, the probe scrolls the map into view to choose that point and scrolls back in the same task: an assertion leaves the
page where it was (the app's scroll listeners still see a `scroll` event, with nothing moved). While the page is still
scrolling by itself (the app's own smooth scroll), the probe does not scroll: a feature outside the window then has no
verdict until the scroll ends. Only actions leave the map scrolled into view. A feature in a part of the map that a scrolling panel around it clips gets no verdict either way.
Actions refuse an invisible feature unless `{ force: true }`. How it works: [DESIGN — Visibility](docs/DESIGN.md#visibility-rendered-is-not-visible).

### What an action waits for (actionability)

0. the map is scrolled into the browser viewport if it is not (a map further down a page cannot be reached by any pointer)
1. the query resolves to exactly one feature, and the style actually paints it (not opacity 0 / transparent)
2. the map is not moving, the target pixel is stable across two frames, and the map's own place on the page holds still (a CSS transition or animation of its container, or a collapsing sidebar, makes the action wait; location actions and drags check this too)
3. the pixel is **on** the feature — for polygons an interior point far from the edge, never the centroid
4. the feature is the **topmost visible hit** at that pixel (its own label on top does not count as an occluder; neither does anything the style paints invisibly, e.g. a transparent hit area)
5. no DOM element (popup, control, overlay) covers the pixel
6. a layer the hit test cannot see (raster, image, video, canvas, heatmap, hillshade, color-relief, background, and custom layers such as deck.gl's) drawn **above** the feature at that pixel: the feature's own layer is probed there, and if hiding it changes no pixel the point is covered and the next one is tried (a translucent overlay, or a transparent gap in an opaque one, lets the action through; so does a heatmap that draws nothing there, although MapLibre 5 and later hit-test it over its whole radius; a target that itself draws nothing at that pixel, such as a ring marker's transparent middle or the inside of a polygon drawn only by its outline, reads as covered even under a translucent overlay: [Limits](#limits)). Each action probes anew. Maps without such a layer above their features pay nothing
7. at the instant the real `pointerdown` arrives, the hit test is re-run; if the feature the query resolved to is no longer there (a look-alike that slid under the pointer does not count), is painted invisibly since the aim, or a layer of item 6 appeared over it since the aim, the click — or the tap, touch events included — is swallowed and the action retries

Works unchanged on rotated, pitched, globe and terrain maps, and on a map inside a container scaled with CSS `transform: scale()`. A location on the far side of the globe, behind the camera or
hidden behind a mountain is an error, never a click on whatever is drawn at that pixel, and a feature query `at` such a
location matches nothing. Features need **no ids**: identity
is id + properties, and id-less look-alikes are told apart by where they are drawn.

Escape hatches: `{ force: true }`, `{ ignoreLayers: [...] }` (per action or per map; never the target's own layer), `{ autoPan: true }`, `{ timeout }`, and
`{ moving: 'allow' }` for a target that never stops moving (`click`, `tap`, `hover`: the pointer leads it; a press that
arrives late, or when the query matches more than one feature, is swallowed before the app sees it — it can time out, it
never presses another feature (for `dblclick`, its first press); a press that was let through is checked again at the `click` event, where MapLibre decides
what was clicked: a target that slipped off in between is a failure after input, never a reported success; `dragTo`, `dragBy`,
`lngLat` and the location actions (`clickAt`, `hoverAt`, `tapAt`…) have no such check and refuse the option). The reasoning and the measurements:
[DESIGN — Actionability](docs/DESIGN.md#actionability-what-click-a-feature-has-to-verify).

### When something fails, it says what WAS on the map

```text
expect(map).toHaveFeature({"layer":"alerts","where":{"severity":"critical"}})

Expected: at least one visible feature matching, within 7000ms
Received: 0 match(es)

What is on the map:
  view: {"center":{"lng":34.78,"lat":32.08},"zoom":12, ...}
  layer "alerts": 3 feature(s) rendered in viewport
    - alerts#3 {"id":3,"name":"Noise complaint","severity":"low"} @(363.5,428.7)
    - alerts#2 {"id":2,"name":"Road closure","severity":"medium"} @(538.3,256.9)
    - alerts#1 {"id":1,"name":"Gas leak","severity":"high"} @(421.8,325.6)
    "severity" wanted "critical"; rendered values: "low", "medium", "high"
```

A failure also attaches `map screenshot — <call>`: the map with every candidate pixel drawn on it (green clickable, red under another feature, orange under DOM, grey not on the feature, blue the asked location). Every successful action attaches `pixel — <call>`: which pixel it used and what it skipped first. `{ failureScreenshots: false }` turns the screenshot off.

It also distinguishes: layer does not exist · layer hidden (`visibility` "none", or the zoom outside its `minzoom`–`maxzoom`) · feature exists in the source but is off-screen · occluded (names the occluder) · ambiguous (lists the matches). The same text is attached to the HTML report / trace as `map state — …`.

### Touch and keyboard

```ts
test.use({ hasTouch: true });
const here = { lng: 34.78, lat: 32.08 };
await map.feature({ layer: 'alerts', id: 2 }).tap();               // Playwright touchscreen.tap, fully verified like click()
await map.pinchAt(here, { scale: 2 });                             // ≈ +1 zoom      } touch moves and multi-touch go through CDP:
await map.twoFingerRotateAt(here, { degrees: 40 });                // ≈ -22° bearing } Chromium only (Playwright has tap() only)
await map.touchDragAt(here, { lng: 34.79, lat: 32.07 });           // one-finger pan (MapLibre adds inertia, as for a real swipe)
await map.doubleTapAt(here);                                       // zoom in by one around the finger
await map.keyboard.press('Shift+ArrowRight');                      // map focused, real key: MapLibre rotates 15°
```

### DOM markers and popups

```ts
await page.getByTestId('toggle-markers').check();                  // (the demo shows its markers on request)
const hq = await map.marker({ at: { lng: 34.84, lat: 32.12 } });   // a normal Playwright Locator
await hq.click();
await map.feature({ layer: 'alerts', id: 1 }).click();
await expect(map).toHavePopup({ feature: { layer: 'alerts', id: 1 }, text: 'Gas leak' });   // open and anchored on the feature
await expect(await map.popup()).toContainText('Severity: high');
const p = await map.clientPoint({ lng: 34.82, lat: 32.11 });      // lng/lat -> client pixel, for page.mouse
await page.mouse.move(p.x, p.y);
```

`map.marker()` / `map.popup()` return normal Locators pinned to their element. Feature actions never click through a marker:
covered pixels are skipped, and a fully covered feature fails with `dom-covered`, naming the element.

### Geometry and drawing

`toHaveGeometry` compares the feature's **full** geometry as the map's source holds it (rendered geometry is tile-clipped)
against a GeoJSON geometry, a vertex list, or `{ circle: { center, edge } }` — in pixels. Where the source cannot give
its data back (a tiled source; a GeoJSON URL source on MapLibre 2–3 and Mapbox GL 1.13), only one drawn piece can be
compared, which a tile border may clip: a match passes, a mismatch is no verdict, so `.not.toHaveGeometry` does not pass
there. Draw helpers are input choreography, not a binding to one tool: `finish` and `gesture` are explicit because
draw tools disagree. Tested against terra-draw and mapbox-gl-draw. Tools with a drag threshold (terra-draw: 8 px)
offset drag-drawn shapes and whole-shape moves by that much — for real users too.

```ts
const [a, b, c, d] = [{ lng: 34.825, lat: 32.04 }, { lng: 34.85, lat: 32.04 }, { lng: 34.85, lat: 32.055 }, { lng: 34.825, lat: 32.055 }];
await page.getByTestId('draw-polygon').click();                           // the app's own draw button (terra-draw here)
await map.draw.polygon([a, b, c, d], { finish: 'click-first' });          // finish gesture is tool-specific
const drawn = map.feature({ layer: 'td-polygon' });
await expect(drawn).toHaveGeometry([a, b, c, d], { tolerancePx: 2 });    // read from the map
await page.getByTestId('draw-select').click();
await drawn.click();                                                      // selected: the tool shows vertex handles
const c2 = { lng: 34.86, lat: 32.065 };
await map.feature({ layer: 'td-point', where: { selectionPoint: true }, at: c }).dragTo(c2);   // move a vertex
const mid = { lng: (a.lng + b.lng) / 2, lat: a.lat }, e = { lng: mid.lng, lat: 32.03 };
await map.feature({ layer: 'td-point', where: { midPoint: true }, at: mid }).dragTo(e);       // insert a vertex
await expect(drawn).toHaveGeometry([a, e, b, c2, d]);
await page.getByTestId('draw-circle').click();
await map.draw.circle({ lng: 34.72, lat: 32.1 }, { lng: 34.73, lat: 32.1 }, { gesture: 'drag' });
await page.getByTestId('draw-polygon').click();
await map.draw.polygon([a, b, c], { finish: 'none' });                    // a shape in progress...
await map.draw.cancel();                                                  // ...and Escape
```

## API reference

`import { geowright, expect, GeowrightError } from 'geowright'` · `import { routeVectorTiles } from 'geowright/tiles'` · app side, types only: `/// <reference types="geowright/app" />` declares `window.__geowright_maps` (`Record<string, unknown>`)

Types, from `'geowright'`: every type a signature names — `MapHandle` `FeatureHandle` `FeatureSetHandle` `FeatureQuery` `FeatureSummary` `LngLat` `PixelPoint` `Geometry` `GeometryExpectation` `WhereOp` `WhereValue` `LayerInfo` `SnapshotOptions` `GeowrightOptions` `ActionOptions` `ActionPointOptions` `SteadyActionOptions` `DrawOptions` `TwoPointDrawOptions` `OverlayWhere` `Modifier` `ViewExpectation`, and `GeowrightMatchers` (the matchers, e.g. for `mergeExpects`). `expect` is typed from `@playwright/test` alone.

**`geowright(page, options?) → MapHandle`** — `mapId` ('main') · `timeout` (actions: a third of the test's timeout, at least 10 000 ms, so `test.slow()` scales it; `waitForIdle()`: two thirds of it; an explicit value applies to both. Matchers use Playwright's expect timeout: set `expect: { timeout }`. As in Playwright, `timeout: 0` means no timeout) · `ignoreLayers` · `mirror` (boolean | `{ max }`) · `failureScreenshots` (true)

| MapHandle | |
|---|---|
| `feature(query)` / `features(query?)` | lazy handles: strict single feature / a set |
| `waitForIdle({ timeout? })` | map loaded, still, tiles in, nothing to repaint. Cannot see app-level async — use retrying assertions for that |
| `viewState()` · `layers()` · `snapshot(opts?)` | camera + bounds + size + `projection` + `terrain` · layer list with source types · text snapshot (`perLayer`, `maxProps`, `layers`, `skipLayers`, `filter`, `maxChars`) |
| `clickAt` `dblclickAt` `rightClickAt` `hoverAt` `tapAt` `(lngLat, opts?)` | real input at a location; waits until it is in view, on the visible surface, uncovered, map still |
| `dragAt(from, to, { steps? })` · `wheelAt(lngLat, deltaY)` | press-move-release · wheel with the pointer there |
| `pinchAt(lngLat, { scale })` · `twoFingerRotateAt(lngLat, { degrees })` · `touchDragAt(from, to)` · `doubleTapAt(lngLat)` | touch gestures via CDP — Chromium only |
| `keyboard.press(key)` | real key press with the map focused |
| `draw.polygon` `draw.line` `(vertices, { finish, vertexDelay? })` | `finish`: `click-last` (default) `click-first` `dblclick` `enter` `none` |
| `draw.rectangle(a, b, opts?)` · `draw.circle(center, edge, opts?)` · `draw.cancel()` | `gesture`: `click-move-click` (default) or `drag`; Escape |
| `marker(where)` · `popup(where?)` → `Promise<Locator>` | DOM overlays as normal Locators; `where`: `{ at?, feature?, tolerancePx? }` |
| `clientPoint(lngLat)` · `lngLatAt({ x, y })` | lng/lat ⇄ client pixel. `clientPoint` waits for a pixel inside the browser window; `lngLatAt` answers at once, for any pixel it is given, and the lng it reports is in [-180, 180] |

| FeatureHandle (`map.feature(q)`) | |
|---|---|
| `click` `rightClick` `dblclick` `tap` `(opts?)` | full actionability + click-time verification |
| `hover(opts?)` | full actionability, verified as the pointer arrives (a miss is aimed at again) |
| `dragTo(lngLat, opts?)` · `dragBy({ dLng, dLat }, opts?)` | drag a handle to a place · move a whole shape (no `moving` option) |
| `info()` · `lngLat(opts?)` · `geometry()` | resolved `FeatureSummary` (`layer id properties geometryType pixel client lngLat visible invisibleBecause state`; its pixel is the best geometric candidate, unverified) · the verified action point as lng/lat (waits and fails like `click()`; no `moving` option) · full geometry from the source (a tiled source: one drawn piece) |

`FeatureSetHandle` (`map.features(q)`): `all()`, `count()` — snapshots, no waiting (a removed or 0×0 map is an error, not 0).

Queries: `layer` · `layerType` · `source` · `id` · `where` · `at` · `visible` (default true; `false`; `'any'`). Action options: `timeout` · `force` (skip occlusion + visibility checks) · `ignoreLayers` · `autoPan` (`true` | `{ lng, lat }`) · `moving: 'allow'` (feature `click`/`rightClick`/`dblclick`, `tap`, `hover` on targets that never stop moving; refused by `dragTo`, `dragBy`, `lngLat` and every location action such as `clickAt` or `tapAt`) · `modifiers` (`Shift` `Control` `Alt` `Meta`) · clicks also `button`, `clickCount`.

| Matcher (all retry; `.not` supported) | |
|---|---|
| `expect(map).toHaveFeature(query, { visible?, timeout? })` | at least one visible feature (`visible: 'any'` = merely rendered) |
| `expect(map.features(q)).toHaveFeatureCount(n)` | exactly n |
| `expect(map.feature(q)).toBeVisibleOnMap({ pixels? })` | one feature, painted by the style and contributing pixels to a patch of about 5×5 px at its action point (a ring or an outline can read as not visible: [Limits](#limits)). To assert absence: `.not.toHaveFeature` |
| `expect(map).toHaveLayerPixels(layerId, { at, radiusPx? = 24 })` | `radiusPx` in CSS pixels. A layer without features (raster, image, canvas, video, heatmap, hillshade) contributes pixels around a location |
| `expect(map.feature(q)).toHaveGeometry(expected, { tolerancePx? = 2 })` | GeoJSON geometry · vertex list · `{ circle: { center, edge } }` |
| `expect(map).toHavePopup({ at?, feature?, text?, tolerancePx? })` | a popup is open and anchored there. `at` is the popup's **tip** within `tolerancePx` (default 8): a default Marker's tip sits about 38 px above its lng/lat, so pass a larger `tolerancePx` or match by `text` / `feature` |
| `expect(map).toHaveView({ center?, zoom?, bearing?, pitch? }, { zoomTolerance? = 0.01, degreesTolerance? = 0.0005 })` | camera, with the map at rest. `degreesTolerance` is for the centre; bearing and pitch match within 0.1°, a bearing as an angle (270 = -90) |

A matcher that cannot reach a verdict fails **whichever way it is written**, and says why: the map is not registered or
was removed, a named layer does not exist, several features match where one is required, the map has not settled (a
`.not` or a count needs it idle, or seen to be never idle), the camera is moving (`toHavePopup`), no pixel of the
feature's geometry hit-tests back to it (`toBeVisibleOnMap`; see Limits). "Could not look" never
passes as "absent". To assert that a layer was removed, check `map.layers()`.

Failures throw `GeowrightError` (actions) or a normal expect failure; both carry "what is on the map" and attach text + an annotated screenshot.

## Agents (Playwright MCP)

A browser agent gets an empty `region "Map"` from the accessibility snapshot. Two fixes, both through Playwright MCP's
`--init-script` (no custom MCP server). The app needs the same one-line hook as for tests; both scripts ship in the package:

```sh
npm i -D geowright
npx @playwright/mcp install-browser chromium   # once: MCP brings its own Playwright, whose Chromium build your tests may not have
npx @playwright/mcp --config geowright-mcp.json --caps=vision --init-script node_modules/geowright/dist/inpage.js
# or --init-script node_modules/geowright/dist/inpage-agent.js: + the accessibility mirror, no --caps needed
```

`geowright-mcp.json` gives headless Chromium a WebGL it can draw with (the software-WebGL flags `npx geowright init` writes for tests):

```json
{
  "browser": {
    "browserName": "chromium",
    "launchOptions": {
      "headless": true,
      "args": ["--disable-gpu", "--enable-unsafe-swiftshader", "--enable-features=AllowSwiftShaderFallback,AllowSoftwareGLFallbackDueToCrashes"]
    }
  }
}
```

- **Text snapshot** — `window.__geowright.snapshot('main')` lists, per entity, its properties, a verified clickable pixel and
  the colour the style evaluates to for it; the agent clicks the listed pixels. It used fewer tool calls than the accessibility mirror in the recorded agent comparisons.
- **Accessibility mirror** — features appear in the normal `browser_snapshot` as buttons, and a normal `browser_click` works
  (a real click that reaches the map). Zero instructions. Also usable from tests: `page.getByRole('button', { name: /Gas leak/ }).click()`.

The skill text for the text snapshot ships as `node_modules/geowright/agent/MAP_SKILL.md` ([`agent/MAP_SKILL.md`](agent/MAP_SKILL.md)):
give it to the agent as instructions. Results of real agent runs:
[DESIGN — The agent layer](docs/DESIGN.md#the-agent-layer-text-snapshot-and-accessibility-mirror).

## Vector tiles without a tile server

```ts
import { routeVectorTiles } from 'geowright/tiles';
await routeVectorTiles(page, '**/vt/buildings/**', { buildings: buildingsGeoJSON }); // key = MVT source-layer
await page.goto('/');                                                                // routes first, then the app
await expect(map).toHaveFeature({ layer: 'buildings' });
```

Real MVT tiles are cut from a GeoJSON fixture inside `page.route`; the app keeps its production `{z}/{x}/{y}.pbf` URL and code path, on another origin and with credentialed tile requests too.
Detail is kept up to `maxZoom` (default 14, an option); a source without `maxzoom` makes MapLibre ask for tiles up to z22, and those are cut from the same data at that detail. Set `maxzoom` on the source where you can: MapLibre then overzooms the tiles itself instead of requesting one set per zoom level.
`scheme` (`'xyz'`, the default, or `'tms'`) must match the source's own `scheme`: a source with `scheme: 'tms'` asks for rows counted from the south, and read as `'xyz'` those are the mirrored band of the world: the layer draws that band's features in the wrong place, or nothing where the fixture has no data there.
`vectorTileHandler(layers)` is the same thing as a plain route handler (for `context.route` or a routing table). In the repository checkout, `tests/wild/basemap.ts` shows a whole offline basemap built this way (style + synthetic city + sprite + glyphs); that test helper is not part of the installed package.
For tiled sources the browser cannot know what is off-screen, and the failure messages say so.

## Limits

- **Tested on Chromium** with software WebGL (the flag set MapLibre uses in its own CI; `npx geowright init` writes it).
  Touch gestures beyond `tap` go through CDP — Chromium only.
- **One line in the app is required.** Auto-discovery is not possible for bundled ESM apps (`tests/discovery.spec.ts` proves it).
- **A map container that STARTS moving on the page after an action's last check is not caught for location actions
  (`clickAt`, `hoverAt`, `dragAt`…) and drags**: they wait while the container is already moving, but cannot re-verify at the
  instant of the input. Multi-point actions (`dragAt`, `draw.*`) look at each point once, at least 50 ms apart, so an earlier
  point can go stale if the container starts moving during a later look. Feature `click()`, `tap()` and `hover()` do
  re-verify at the real event.
- **`waitForIdle()` cannot see app-level async** (a fetch that adds a layer later) — use the retrying assertions for that.
- **Mapbox GL JS 1.13: GeoJSON set again while its last data is still loading** ("clear, then load": `setData(empty)`,
  then `setData(url)`) is not waited for. 1.13 calls the source loaded, and the map idle, as soon as the first load ends,
  while the URL is still being fetched, so a `.not` or a count can pass before the new data arrives. MapLibre 2–6 are
  not affected. On 1.13, wait for something the app shows once its data is in before such an assertion.
- **Sources re-pointed faster than they load** (image, vector tiles, GeoJSON URLs) count as never idle when repeated
  overlapping starts continue through the wait. `.not` and counts then judge the current map; the newest data may
  still be on its way. A single load, two replacements, or completed sequential loads still need to settle.
- **Tiled sources:** the browser cannot know what is off-screen, and the failure messages say so.
- **On a globe** MapLibre's own viewport-wide query is wrong; the workaround is a grid: an extrusion narrower than 16 px whose
  footprint centre is off-screen can be missed by viewport-wide queries (never mis-clicked; a query `at` it finds it).
- **A feature drawn away from its geometry** (a label under its point by `text-offset`, `line-offset`, a `*-translate`)
  is aimed at on its geometry: the point and a few pixels around it, a line's vertices and midpoints. When it is drawn
  further away than that, an action on it fails with `not-found`; act where it is drawn with `clickAt` (`hoverAt`,
  `tapAt`…). `toBeVisibleOnMap` reaches no verdict either way: `{ pixels: false }` checks its paint, and
  `.not.toHaveFeature` asserts that it is gone.
- **A feature that draws nothing at its action point** reads as not visible to the pixel probe of `toBeVisibleOnMap`,
  which looks only at a patch of about 5×5 CSS px there (the first point the hit test gives back to the feature: a
  point's centre, a line's middle, a polygon's interior far from its edge). That is the case for a ring marker with a
  transparent fill, a polygon drawn only by its outline, a two-line label whose centre falls between its lines, a dashed
  line whose middle falls in a gap. `toBeVisibleOnMap` fails on such a feature, and `.not.toBeVisibleOnMap()` **passes**
  although a user sees it. Assert that a feature is gone with `.not.toHaveFeature`; check one of these with
  `toBeVisibleOnMap({ pixels: false })` (its paint) and `toHaveLayerPixels` where it is drawn (its pixels). An action
  reads the same patch for a pixel-only layer above its target: under a raster, even a translucent one, an action on such
  a feature fails with `occluded`; pass `{ ignoreLayers: [...] }` for that layer.
- **An opaque overlay whose colour changes by itself** (a playing video, a paint transition) can read as the target showing
  through, so a click goes through to the layer below and `toBeVisibleOnMap` passes: the pixel probe cannot tell an overlay's
  own colour drift from a target. Over such a map, assert on the feature (`toHaveFeature`) or pause the
  overlay first.
- **A location just past a globe's horizon** is clicked at the limb, and a query `at` it can match the near-side feature:
  the hit test and `getBounds` both stop at the horizon. On a globe, keep the locations of an action well inside the visible disc.
- **`hover` on a moving target** is only dependable when frames are short; `click` holds up.
- **A feature whose source the app replaces on every frame is never "at rest"**, even one that stands still: "at rest"
  is the same pixel two frames running *and* no data replacement of its source in between (a starved renderer draws a
  moving feature at the same pixel too). Such a feature needs `moving: 'allow'`, whose check at the real event tells a
  hit from a miss.
- **A press that was verified can still miss at the `click` event** (a `dblclick`: its first click only), where MapLibre decides which layer
  was clicked, after the release: a fast `moving: 'allow'` target moved off in between, or the app moved the map on the press. The hit test
  is run again there, and a miss is a failure after input: the click was sent once, the app's click landed elsewhere, and it is not sent again.
  What cannot be done is to take the click back.
- **Pixel-only layers above a feature** (raster, image, video, canvas, heatmap, hillshade, color-relief, background, and custom layers such as deck.gl's) are checked with a pixel probe:
  a few renders per action on a map that has one over its features, and not at all for `moving: 'allow'`. Pixels that change
  inside an overlay between the last probe and the press are not re-checked (over a target whose opacity is data-driven
  that time includes a reload of its source, and an overlay given new data during the first one is probed once more); over such a target, an
  overlay that changes colour by itself can still, rarely, pass for the target showing through; on MapLibre 2 and Mapbox GL 1 a custom layer is not
  checked at all; the snapshot does not probe (it marks such a feature `under-pixel-layer:<ids>`): [RECIPES](docs/RECIPES.md#a-raster-or-image-layer-is-drawn-over-my-features).
- The injected script is about 455 KB, not minified (99 KB gzipped; it bundles MapLibre's style-expression evaluator); test-time only, nothing ships in your app.

The full list, with costs measured on a dense map: [DESIGN — Costs and known limitations](docs/DESIGN.md#costs-and-known-limitations).

## Supported map library versions

Developed against MapLibre GL JS 6. The same small page and the same core specs run against every major below
(`npm run test:compat`, `tests/compat/`, its own CI job; 189 tests). "✓" means asserted by that matrix, not assumed.
Newer public methods are feature-detected, never version-sniffed; what an old version cannot do is said in failure
diagnostics and in the snapshot (`note: …`) instead of being answered wrongly, with one known exception on Mapbox GL
JS 1.13 ([Limits](#limits)): a GeoJSON source set again while it loads.

**Playwright:** `@playwright/test` 1.49 or later: CI runs the full suite on 1.49.0 (the floor) and on the current
version ([0017](docs/decisions/0017-the-playwright-floor-is-the-one-ci-runs.md)).

| | Mapbox GL JS 1.13 (BSD) | MapLibre 2 | MapLibre 3 | MapLibre 4 | MapLibre 5 | MapLibre 6 |
|---|---|---|---|---|---|---|
| assert: `toHaveFeature`, counts, `where`, `.not` | ✓ (one exception: [Limits](#limits)) | ✓ | ✓ | ✓ | ✓ | ✓ |
| act: click / hover / drag on features and locations, click-time verification | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| occlusion by other features and by DOM, `force`, `ignoreLayers` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| visibility from paint evaluation (opacity 0, transparent colour, zero size) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| pixel probe (`toBeVisibleOnMap`, `toHaveLayerPixels`) | ✓ through the frame loop: 4 real frames, may flicker once | ✓ | ✓ | ✓ | ✓ | ✓ |
| text snapshot, evaluated colours, entities | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| markers and popups (`map.marker`, `map.popup`, `toHavePopup`) | ✓ (`mapboxgl-` classes) | ✓ | ✓ | ✓ | ✓ | ✓ |
| vector-tile sources, `routeVectorTiles` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| camera (`toHaveView`), `toHaveGeometry` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| off-screen GeoJSON features: diagnostics, snapshot, `autoPan: true` | ✓ if the source was given an object; a URL: unknowable, and said so | same | same | ✓ | ✓ | ✓ |
| globe projection (far-side refusal, viewport-query workaround) | n/a | n/a | n/a | n/a | not in the matrix | ✓ (main suite) |
| terrain, fill-extrusion lift, touch, drawing tools, the wild apps | not in the matrix | not in the matrix | not in the matrix | not in the matrix | not in the matrix | ✓ (main suite) |

Mapbox GL JS **v2 and later are proprietary and are not tested**. The shared v1 API family suggests some compatibility,
but this project makes no claim for those versions. Style expressions newer than the bundled evaluator are reported
once and treated as visible; older expressions are supported.

## Developing geowright

```sh
npm i && npx playwright install chromium
node demo/scripts/copy-worker.mjs      # MapLibre 6 worker files -> demo/public (after a fresh install)
npx playwright test                    # builds the demo, serves it on :4173, runs headless
```

The suite needs no network: everything a page fetches is answered from fixtures (`page.route`), and a non-local request
fails the test. `demo/` is the app under test, `src/inpage/` is injected into the page (adapter seam, engine, MapLibre adapter),
`src/playwright/` is the test-side API, `wild/` holds third-party test apps, `agent/` the Playwright MCP pieces.

The agent path against the demo, from a checkout (`npm run build:inpage` writes both injected scripts, with their
license banner; `agent/mcp-probe.mjs` drives the whole path without an LLM):

```sh
npm run build:inpage
npx @playwright/mcp install-browser chromium   # once: MCP launches its own Playwright's Chromium build, not the suite's
npx @playwright/mcp --config agent/playwright-mcp.config.json --init-page agent/init-page.ts \
    --init-script dist/inpage.js --caps=vision        # or dist/inpage-agent.js, no caps needed
```
Ground rules, the flake bar and the sign-off: [CONTRIBUTING.md](CONTRIBUTING.md).

## Open source, and staying that way

Everything a test verdict depends on is open source under Apache-2.0 and stays that way: the adapter, the engine,
actionability and click-time verification, the matchers, the snapshot and accessibility mirror, diagnostics and failure
artefacts, the offline tile tooling, the agent/MCP integration, and adapters. If paid offerings ever exist they will be
about what happens to results after a run (support, hosted reporting) — never a feature a test needs in order to pass or
fail correctly.

## License

[Apache-2.0](LICENSE) — Copyright 2026 Shai Sinai. See [NOTICE](NOTICE).
The scripts injected into the page bundle MapLibre's style-spec expression evaluator (ISC / BSD-3-Clause) and three
small libraries; their license texts ship in the package as `dist/THIRD_PARTY_LICENSES.txt`, generated from the
bundler's own input list. Everything else this repo uses or vendors: [docs/THIRD_PARTY_NOTICES.md](docs/THIRD_PARTY_NOTICES.md)
and [`wild/README.md`](wild/README.md). Contributions: inbound = outbound, with a DCO sign-off — see
[CONTRIBUTING.md](CONTRIBUTING.md).
