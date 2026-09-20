# geowright

Grey-box testing for canvas maps in Playwright. First adapter: MapLibre GL JS 6.
Prototype quality. Design log and honest caveats: the design notes.
Tested against apps its author did not write — MapLibre's own examples and react-map-gl / Vue / Svelte wrapper apps — in [`wild/`](wild/README.md); the scoreboard is in the design notes (an earlier phase).

Closes two gaps a DOM-only Playwright suite has on a WebGL map:

- **ASSERT** — after an action in the normal UI, verify something was added to / changed on / removed from the map.
- **ACT** — perform actions that start on the map: click a feature, right-click a location, draw, drag a vertex.

Actions are **real input** (`page.mouse` at projected pixels), never `map.fire()`. The adapter uses MapLibre's **public API only**.

## App side: one line, no dependency

```ts
const map = new maplibregl.Map({ ... });
(window.__geowright_maps ??= {}).main = map;   // that's it; nothing is imported, nothing ships
```

The in-page adapter is injected by Playwright at test time. (Auto-discovery is not possible for bundled ESM apps — `tests/discovery.spec.ts` proves it.)

## Test side

```ts
import { geowright, expect } from '../src/playwright';

const map = geowright(page);                       // { mapId?: 'main', timeout?, ignoreLayers?, mirror?, failureScreenshots? }
await map.waitForIdle();

// ASSERT — retrying, like web-first assertions
await expect(map).toHaveFeature({ layer: 'alerts', where: { severity: 'high' } });
await expect(map).not.toHaveFeature({ layer: 'alerts', id: 2 });
await expect(map.features({ layer: 'alerts' })).toHaveFeatureCount(3);
await expect(map).toHaveView({ center: { lng: 35.2, lat: 32.08 }, zoom: 12 });
await expect(map).toHaveFeature({ layer: 'sensors', id: 502 }, { visible: 'any' });  // opt out: "rendered" incl. opacity-0
await expect(map.feature({ layer: 'sensors', id: 501 })).toBeVisibleOnMap();       // paint AND pixels

// ACT — auto-waiting, strict, verified
await map.feature({ layer: 'parcels', id: 123 }).click();
await map.feature({ layer: 'alerts', id: 4 }).click({ autoPan: true });   // map's scrollIntoView, opt-in
await map.feature({ layer: 'td-point', at: vertex }).dragTo({ lng, lat });
await map.clickAt({ lng: 34.78, lat: 32.08 });
await map.rightClickAt({ lng: 34.81, lat: 32.07 });
await map.feature({ layer: 'alerts', id: 1 }).click({ modifiers: ['Shift'] });
await map.wheelAt({ lng: 34.8, lat: 32.1 }, -600);                        // zooms around the pointer
await map.feature({ layer: 'buildings', id: 1028 }).click({ autoPan: { lng: 35.2, lat: 32.09 } }); // tiled source
await map.draw.polygon([a, b, c, d], { finish: 'click-first' });          // finish gesture is tool-specific
await map.draw.rectangle(corner, opposite);                                // or { gesture: 'drag' }
await map.draw.circle(center, edge, { gesture: 'drag' });
await map.draw.cancel();                                                  // Escape
await map.feature({ layer: 'td-point', where: { midPoint: true }, at: mid }).dragTo(to);   // insert a vertex
await map.feature({ layer: 'td-polygon' }).dragBy({ dLng: -0.02, dLat: 0.01 });           // move the whole shape
await expect(map.feature({ layer: 'td-polygon' })).toHaveGeometry([a, b, c, d], { tolerancePx: 2 });  // read from the MAP
```

### Queries

```ts
{ layer: 'alerts' }                                   // string or string[]
{ layer: 'alerts', id: 7 }
{ layer: 'alerts', where: { severity: 'high' } }      // equality
{ layer: 'alerts', where: { name: /^gas/i } }         // RegExp
{ layer: 'alerts', where: { severity: { in: ['high', 'medium'] }, id: { gte: 2 } } }
//   operators: eq ne gt gte lt lte in matches exists
{ layer: 'td-point', at: { lng, lat } }               // only what is rendered under that location
{ layer: 'sensors', visible: 'any' }                  // default is VISIBLE only; 'any' = MapLibre's "rendered" (see below)
```

`map.feature(q)` is **strict** (exactly one match, like a Locator); `map.features(q)` is a set.
Handles are lazy: nothing is resolved until an action or assertion runs.

### Rendered is not visible

MapLibre's `queryRenderedFeatures` also returns features painted with opacity 0, a transparent colour, zero
radius/width or `text-opacity: 0` — so a plain `toHaveFeature` can pass on something no user can see.

- **Queries match only what a user can see, by default.** The layer's paint properties are evaluated **for that
  feature** — data-driven expressions, zoom, feature-state — with MapLibre's own expression evaluator. Cheap; failure
  messages say which property (`[NOT VISIBLE: circle-opacity evaluates to 0]`). Opt out with `visible: 'any'`
  (in the query, or `toHaveFeature(q, { visible: 'any' })`); `visible: false` matches only the invisible ones.
- `expect(map.feature(q)).toBeVisibleOnMap()`: the paint check **and** a pixel probe (do the canvas pixels at the
  feature change when its layer is not drawn?). Catches a transparent icon image. The probe re-renders three
  times and toggles the layer within one task — use it where it matters, `{ pixels: false }` skips it.
- Actions refuse an invisible feature by default (`{ force: true }` overrides). Every `FeatureSummary` has
  `visible` / `invisibleBecause`; the snapshot tags `NOT-VISIBLE(...)`.

### What an action waits for (actionability)

1. the query resolves to exactly one feature, and the style actually paints it (not opacity 0 / transparent)
2. the map is not moving, and the target pixel is stable across two frames
3. the pixel is **on** the feature — for polygons an interior point far from the edge, never the centroid
4. the feature is the **topmost visible hit** at that pixel (its own label on top does not count as an occluder; neither does anything the style paints invisibly, e.g. a transparent hit area)
5. no DOM element (popup, control, overlay) covers the pixel
6. at the instant the real `pointerdown` arrives, the hit test is re-run; if the target is no longer there the click is swallowed and the action retries

Works unchanged on rotated, pitched, globe and terrain maps (pixels come from `map.project()`, candidates are verified by MapLibre's hit test). A location on the far side of the globe, behind the camera or **hidden behind a mountain** is an error, never a click on whatever is drawn at that pixel. `fill-extrusion` features are acted on where they are **drawn** — roof first, then walls, then footprint — so a tower whose footprint is outside the viewport is still clickable.

Features need **no ids**: identity is id + properties, and id-less features with identical properties (three POIs that are all `{ icon: "music" }`) are told apart by where they are drawn. Layer and source ids may be generated by a wrapper (`jsx-source-0`): query by layer id, read the rest from `map.layers()` / `map.snapshot()`.

Escape hatches: `{ force: true }`, `{ ignoreLayers: [...] }` (per action or per map), `{ autoPan: true }`, `{ timeout }`.

### When something fails, it says what WAS on the map

```
expect(map).toHaveFeature({"layer":"alerts","where":{"severity":"critical"}})

Expected: at least one rendered feature matching, within 7000ms
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

It also distinguishes: layer does not exist · layer hidden · feature exists in the source but is off-screen · occluded (names the occluder) · ambiguous (lists the matches). The same text is attached to the HTML report / trace as `map state — …`.

### Touch and keyboard

```ts
test.use({ hasTouch: true });
await map.feature({ layer: 'alerts', id: 2 }).tap();               // Playwright touchscreen.tap, fully verified like click()
await map.pinchAt({ lng, lat }, { scale: 2 });                     // ≈ +1 zoom      } touch moves and multi-touch go through CDP:
await map.twoFingerRotateAt({ lng, lat }, { degrees: 40 });        // ≈ -22° bearing } Chromium only (Playwright has tap() only)
await map.touchDragAt(from, to);                                   // one-finger pan (MapLibre adds inertia, as for a real swipe)
await map.doubleTapAt({ lng, lat });                               // zoom in by one around the finger
await map.keyboard.press('Shift+ArrowRight');                      // map focused, real key: MapLibre rotates 15°
```

### DOM markers and popups

```ts
const hq = await map.marker({ at: { lng: 34.84, lat: 32.12 } });   // a normal Playwright Locator
await hq.click();
await expect(map).toHavePopup({ feature: { layer: 'alerts', id: 1 }, text: 'Gas leak' });   // open AND anchored on the feature
await expect(await map.popup()).toContainText('Severity: high');
const p = await map.clientPoint({ lng: 34.82, lat: 32.11 });      // lng/lat -> client pixel, for page.mouse
```

`map.marker()` / `map.popup()` Locators are pinned to **their element** (a custom selector engine, no DOM mutation): other markers may come and go; if the app removes or replaces the element the Locator matches nothing. Works with wrapper-rendered markers (react-map-gl `<Marker>`).

Feature actions never click through a marker: covered candidate pixels are skipped, and a fully covered feature fails with `dom-covered`, naming the element.

### Geometry and drawing

`toHaveGeometry` compares the feature's **full** geometry as the map's source holds it (rendered geometry is
tile-clipped) against a GeoJSON geometry, a vertex list, or `{ circle: { center, edge } }` — in pixels, ring
start/winding-insensitive. Draw helpers are input choreography, not a binding to one tool: `finish`
(`click-last | click-first | dblclick | enter | none`) and `gesture` (`click-move-click | drag`) are explicit
because draw tools disagree. Tested against terra-draw and mapbox-gl-draw. Note: tools with a drag threshold
(terra-draw: 8px) offset drag-drawn shapes and whole-shape moves by that much — for real users too.

## API reference

`import { geowright, expect, GeowrightError } from 'geowright'` · `import { routeVectorTiles } from 'geowright/tiles'`

**`geowright(page, options?) → MapHandle`** — `mapId` ('main') · `timeout` (10 000 ms, actions/waits; assertions use Playwright's expect timeout) · `ignoreLayers` · `mirror` (boolean | `{ max }`) · `failureScreenshots` (true)

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
| `clientPoint(lngLat)` · `lngLatAt({ x, y })` | lng/lat ⇄ client pixel |

| FeatureHandle (`map.feature(q)`) | |
|---|---|
| `click` `rightClick` `dblclick` `hover` `tap` `(opts?)` | full actionability + click-time verification |
| `dragTo(lngLat, opts?)` · `dragBy({ dLng, dLat }, opts?)` | drag a handle to a place · move a whole shape |
| `info()` · `lngLat(opts?)` · `geometry()` | resolved `FeatureSummary` (`layer id properties geometryType pixel client lngLat visible invisibleBecause state`; its pixel is the best GEOMETRIC candidate, unverified) · the VERIFIED action point as lng/lat (waits and fails like `click()`) · full geometry from the source |

`FeatureSetHandle` (`map.features(q)`): `all()`, `count()` — snapshots, no waiting.

Queries: `layer` · `id` · `where` · `at` · `visible` (default true; `false`; `'any'`). Action options: `timeout` · `force` (skip occlusion + visibility checks) · `ignoreLayers` · `autoPan` (`true` | `{ lng, lat }`) · `modifiers` (`Shift` `Control` `Alt` `Meta`) · clicks also `button`, `clickCount`.

| Matcher (all retry; `.not` supported) | |
|---|---|
| `expect(map).toHaveFeature(query, { visible?, timeout? })` | at least one VISIBLE feature (`visible: 'any'` = merely rendered) |
| `expect(map.features(q)).toHaveFeatureCount(n)` | exactly n |
| `expect(map.feature(q)).toBeVisibleOnMap({ pixels? })` | one feature, painted by the style AND contributing pixels |
| `expect(map.feature(q)).toHaveGeometry(expected, { tolerancePx? = 2 })` | GeoJSON geometry · vertex list · `{ circle: { center, edge } }` |
| `expect(map).toHavePopup({ at?, feature?, text?, tolerancePx? })` | a popup is open and anchored there |
| `expect(map).toHaveView({ center?, zoom?, bearing?, pitch? }, { zoomTolerance?, degreesTolerance? })` | camera, with the map at rest |

Failures throw `GeowrightError` (actions) or a normal expect failure; both carry "what is on the map" and attach text + an annotated screenshot.

## Agents (Playwright MCP)

Browser agents get an empty `region "Map"` from the accessibility snapshot. Two ways to fix that, both via
Playwright MCP's `--init-script` (no custom MCP server):

```sh
npm run build:inpage      # dist/inpage.js        -> adapter + window.__geowright.snapshot()
npx esbuild src/inpage/agent-entry.ts --bundle --format=iife --outfile=dist/inpage-agent.js   # + accessibility mirror
npx @playwright/mcp --config agent/playwright-mcp.config.json --init-page agent/init-page.ts \
    --init-script dist/inpage.js --caps=vision        # or dist/inpage-agent.js, no caps needed
```

- **Text snapshot** — per entity: properties, a verified clickable pixel, the **colour the style evaluates to for that feature** (`drawn red(#d32f2f)`; per layer when constant), feature-state; per map: projection / terrain, pixel-only layers, what is outside the viewport. The agent calls `browser_evaluate` with `window.__geowright.snapshot('main')` (see `agent/MAP_SKILL.md`) and
  clicks the listed client pixels with `browser_mouse_click_xy`. Most efficient in our runs.
- **Accessibility mirror** — features appear in the normal `browser_snapshot` as buttons; normal `browser_click` works
  (a real click that bubbles to the map, like a MapLibre Marker). Zero instructions. Also usable from tests:
  `page.getByRole('button', { name: /Gas leak/ }).click()`.

`agent/mcp-probe.mjs` exercises the whole path without an LLM; results of real agent runs are in the design notes (an earlier phase).

## Vector tiles without a tile server

```ts
import { routeVectorTiles } from 'geowright/tiles';
await routeVectorTiles(page, '**/vt/buildings/**', { buildings: buildingsGeoJSON }); // key = MVT source-layer
```

Real MVT tiles are cut from a GeoJSON fixture inside `page.route`; the app keeps its production `{z}/{x}/{y}.pbf` URL and code path.
`vectorTileHandler(layers)` is the same thing as a plain route handler (for `context.route` or a routing table). `tests/wild/basemap.ts` builds a whole offline basemap this way (style + synthetic city + sprite + glyphs).
For tiled sources the browser cannot know what is off-screen, and the failure messages say so.

## Determinism

No network. Inline style, GeoJSON sources, raster tiles fulfilled with `page.route`, glyphs served by the app (Noto Sans, OFL). The `map` fixture aborts and fails the test on any non-local request. Headless software WebGL flags (same set MapLibre uses in its own CI) are documented in `playwright.config.ts`.

## Run

```sh
npm i && npx playwright install chromium
node demo/scripts/copy-worker.mjs      # MapLibre 6 worker files -> demo/public (after a fresh install)
npx playwright test                    # builds the demo, serves it on :4173, runs headless (e2e + tests/unit)
npx playwright test --repeat-each=20   # the flake bar
npm run dev                            # poke at the demo app by hand
bash scripts/kill-preview.sh           # stop THIS repo's preview server so the next run rebuilds the demo
npm run pack:local                     # dist/geowright-0.0.0.tgz for trying it in another project (for local testing)
```

## Layout

```
demo/             the system under test (Vite + MapLibre 6 + terra-draw; dense.html = 5k points; draw2.html = mapbox-gl-draw), no test code inside
src/inpage/       injected into the page: adapter seam (types.ts), engine (library-agnostic), MapLibre adapter
src/playwright/   geowright(page), handles, expect matchers
wild/             apps we did NOT write (MapLibre examples, react-map-gl / Vue / Svelte apps), one-line hook each, their licenses, fixtures
tests/            assert / act / draw / draw2 / dense / camera / overlays / artefacts / touch-keyboard / input / visibility / vector-tiles / two-maps / discovery / snapshot / mirror specs; tests/wild = the wild-apps suite; tests/unit = pure-function tests
agent/            Playwright MCP config, init-page hook, skill text, MCP probe + CLI bridge
```
