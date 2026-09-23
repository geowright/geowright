# geowright

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Grey-box testing for canvas maps in Playwright. First adapter: MapLibre GL JS 2–6 and Mapbox GL JS 1.13 ([support table](#supported-map-library-versions)).
Early (0.x): the API may still change. Design decisions, the evidence behind them and honest caveats: [docs/DESIGN.md](docs/DESIGN.md).
Tested against apps its author did not write — MapLibre's own examples and react-map-gl / Vue / Svelte wrapper apps — in [`wild/`](wild/README.md); the scoreboard is in [docs/DESIGN.md](docs/DESIGN.md).

Closes two gaps a DOM-only Playwright suite has on a WebGL map:

- **ASSERT** — after an action in the normal UI, verify something was added to / changed on / removed from the map.
- **ACT** — perform actions that start on the map: click a feature, right-click a location, draw, drag a vertex.

Actions are **real input** (`page.mouse` at projected pixels), never `map.fire()`. The adapter uses MapLibre's **public API only**.

## Start

```sh
npm i -D geowright @playwright/test && npx playwright install chromium
npx geowright init      # a fixture, the software-WebGL flags (+ a whole playwright.config if you have none), a first spec
                        # that prints map.snapshot(), and the hook for YOUR wrapper
```
More: [docs/RECIPES.md](docs/RECIPES.md).

## App side: one line, no dependency

<!-- example: skip (app-side code: it runs in your app, not in a test; `{ ... }` stands for your map options) -->
```ts
const map = new maplibregl.Map({ ... });
(window.__geowright_maps ??= {}).main = map;   // that's it; nothing is imported, nothing ships
```

In TypeScript, add `/// <reference types="geowright/app" />` to a `.d.ts` file your **app's** tsconfig includes (a Vite
app has `src/vite-env.d.ts`) and the line compiles as written, without `(window as any)`. It is types only: nothing ships.

With a wrapper the map instance arrives in a callback — still one line (all three verified in `wild/apps/`):

<!-- example: skip (app-side component markup with elided props; each line is verified in its wild/apps/ app) -->
```jsx
<Map onLoad={e => ((window.__geowright_maps ??= {}).main = e.target)} … />              // react-map-gl
<MapLibre onload={(e) => ((window.__geowright_maps ??= {}).main = e.target)} … />      // svelte-maplibre-gl
<mgl-map @map:load="e => ((e.map.getContainer().ownerDocument.defaultView.__geowright_maps ??= {}).main = e.map)" … />
// ^ vue-maplibre-gl: a Vue TEMPLATE cannot see `window`; in <script setup> the plain line works
```

Wrappers fire that callback on MapLibre's `load`, which needs every declared source: if a data request fails, the map is never registered.

The in-page adapter is injected by Playwright at test time. (Auto-discovery is not possible for bundled ESM apps — `tests/discovery.spec.ts` proves it.)

## Test side

```ts
import { geowright, expect } from 'geowright';   // inside this repository: '../src/playwright'

const map = geowright(page);                       // { mapId?: 'main', timeout?, ignoreLayers?, mirror?, failureScreenshots? }
await map.waitForIdle();

// ASSERT — retrying, like web-first assertions
await expect(map).toHaveFeature({ layer: 'alerts', where: { severity: 'high' } });
await expect(map.features({ layer: 'alerts' })).toHaveFeatureCount(3);
await page.getByTestId('alert-remove-2').click();                          // an action in the app's normal UI...
await expect(map).not.toHaveFeature({ layer: 'alerts', id: 2 });           // ...and its effect on the map
await page.getByTestId('toggle-sensors').check();
await expect(map).toHaveFeature({ layer: 'sensors', id: 502 }, { visible: 'any' });  // opt out: "rendered" incl. opacity-0
await expect(map.feature({ layer: 'sensors', id: 501 })).toBeVisibleOnMap();       // paint AND pixels
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
  { layer: 'sensors', visible: 'any' },                  // default is VISIBLE only; 'any' = MapLibre's "rendered" (see below)
  { layerType: 'circle', where: { cluster: true } },     // layer ids GENERATED by a wrapper (svmlgl-layer-0)? say what the layer IS
  { source: 'earthquakes', layerType: ['circle', 'symbol'] },
];
```

`map.feature(q)` is **strict** (exactly one match, like a Locator); `map.features(q)` is a set.
Handles are lazy: nothing is resolved until an action or assertion runs.

### Visible by default

MapLibre's `queryRenderedFeatures` also returns features painted with opacity 0, a transparent colour or zero size — so a
naive "the feature exists" check passes on something no user can see. Here queries match **only what a user can see**: the
layer's paint properties are evaluated for that feature (data-driven expressions, zoom, feature-state), and a failure says
which property hid it (`[NOT VISIBLE: circle-opacity evaluates to 0]`) and why: its value, the expression branch that
produced it, and the zoom (`-> parks#7 is not visible at zoom 11.2: fill-opacity is 0 because the match on ["get","kind"]
took its fallback for kind="park"`). `visible: 'any'` opts out; `visible: false` matches
only the invisible ones. `expect(map.feature(q)).toBeVisibleOnMap()` adds a pixel probe (catches a transparent icon image).
Actions refuse an invisible feature unless `{ force: true }`. How it works: [DESIGN — Visibility](docs/DESIGN.md#visibility-rendered-is-not-visible).

### What an action waits for (actionability)

0. the map is scrolled into the browser viewport if it is not (a map further down a page cannot be reached by any pointer)
1. the query resolves to exactly one feature, and the style actually paints it (not opacity 0 / transparent)
2. the map is not moving, and the target pixel is stable across two frames
3. the pixel is **on** the feature — for polygons an interior point far from the edge, never the centroid
4. the feature is the **topmost visible hit** at that pixel (its own label on top does not count as an occluder; neither does anything the style paints invisibly, e.g. a transparent hit area)
5. no DOM element (popup, control, overlay) covers the pixel
6. at the instant the real `pointerdown` arrives, the hit test is re-run; if the target is no longer there the click is swallowed and the action retries

Works unchanged on rotated, pitched, globe and terrain maps. A location on the far side of the globe, behind the camera or
hidden behind a mountain is an error, never a click on whatever is drawn at that pixel. Features need **no ids**: identity
is id + properties, and id-less look-alikes are told apart by where they are drawn.

Escape hatches: `{ force: true }`, `{ ignoreLayers: [...] }` (per action or per map), `{ autoPan: true }`, `{ timeout }`, and
`{ moving: 'allow' }` for a target that never stops moving (the pointer leads it; a press that arrives late is swallowed
before the app sees it — it can time out, it never clicks the wrong thing). The reasoning and the measurements:
[DESIGN — Actionability](docs/DESIGN.md#actionability-what-click-a-feature-has-to-verify).

### When something fails, it says what WAS on the map

```text
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
await expect(map).toHavePopup({ feature: { layer: 'alerts', id: 1 }, text: 'Gas leak' });   // open AND anchored on the feature
await expect(await map.popup()).toContainText('Severity: high');
const p = await map.clientPoint({ lng: 34.82, lat: 32.11 });      // lng/lat -> client pixel, for page.mouse
await page.mouse.move(p.x, p.y);
```

`map.marker()` / `map.popup()` return normal Locators pinned to their element. Feature actions never click through a marker:
covered pixels are skipped, and a fully covered feature fails with `dom-covered`, naming the element.

### Geometry and drawing

`toHaveGeometry` compares the feature's **full** geometry as the map's source holds it (rendered geometry is tile-clipped)
against a GeoJSON geometry, a vertex list, or `{ circle: { center, edge } }` — in pixels. Draw helpers are input
choreography, not a binding to one tool: `finish` and `gesture` are explicit because draw tools disagree. Tested against
terra-draw and mapbox-gl-draw. Tools with a drag threshold (terra-draw: 8 px) offset drag-drawn shapes and whole-shape
moves by that much — for real users too.

```ts
const [a, b, c, d] = [{ lng: 34.825, lat: 32.04 }, { lng: 34.85, lat: 32.04 }, { lng: 34.85, lat: 32.055 }, { lng: 34.825, lat: 32.055 }];
await page.getByTestId('draw-polygon').click();                           // the app's own draw button (terra-draw here)
await map.draw.polygon([a, b, c, d], { finish: 'click-first' });          // finish gesture is tool-specific
const drawn = map.feature({ layer: 'td-polygon' });
await expect(drawn).toHaveGeometry([a, b, c, d], { tolerancePx: 2 });    // read from the MAP
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

Queries: `layer` · `layerType` · `source` · `id` · `where` · `at` · `visible` (default true; `false`; `'any'`). Action options: `timeout` · `force` (skip occlusion + visibility checks) · `ignoreLayers` · `autoPan` (`true` | `{ lng, lat }`) · `moving: 'allow'` (targets that never stop moving) · `modifiers` (`Shift` `Control` `Alt` `Meta`) · clicks also `button`, `clickCount`.

| Matcher (all retry; `.not` supported) | |
|---|---|
| `expect(map).toHaveFeature(query, { visible?, timeout? })` | at least one VISIBLE feature (`visible: 'any'` = merely rendered) |
| `expect(map.features(q)).toHaveFeatureCount(n)` | exactly n |
| `expect(map.feature(q)).toBeVisibleOnMap({ pixels? })` | one feature, painted by the style AND contributing pixels |
| `expect(map).toHaveLayerPixels(layerId, { at, radiusPx? = 24 })` | a layer WITHOUT features (raster, image, canvas, video, heatmap, hillshade) contributes pixels around a location |
| `expect(map.feature(q)).toHaveGeometry(expected, { tolerancePx? = 2 })` | GeoJSON geometry · vertex list · `{ circle: { center, edge } }` |
| `expect(map).toHavePopup({ at?, feature?, text?, tolerancePx? })` | a popup is open and anchored there |
| `expect(map).toHaveView({ center?, zoom?, bearing?, pitch? }, { zoomTolerance?, degreesTolerance? })` | camera, with the map at rest |

Failures throw `GeowrightError` (actions) or a normal expect failure; both carry "what is on the map" and attach text + an annotated screenshot.

## Agents (Playwright MCP)

A browser agent gets an empty `region "Map"` from the accessibility snapshot. Two fixes, both through Playwright MCP's
`--init-script` (no custom MCP server):

```sh
npm run build:inpage      # dist/inpage.js        -> adapter + window.__geowright.snapshot()
npx esbuild src/inpage/agent-entry.ts --bundle --format=iife --outfile=dist/inpage-agent.js   # + accessibility mirror
npx @playwright/mcp --config agent/playwright-mcp.config.json --init-page agent/init-page.ts \
    --init-script dist/inpage.js --caps=vision        # or dist/inpage-agent.js, no caps needed
```

- **Text snapshot** — `window.__geowright.snapshot('main')` lists, per entity, its properties, a verified clickable pixel and
  the colour the style evaluates to for it; the agent clicks the listed pixels. The most efficient in our runs.
- **Accessibility mirror** — features appear in the normal `browser_snapshot` as buttons, and a normal `browser_click` works
  (a real click that reaches the map). Zero instructions. Also usable from tests: `page.getByRole('button', { name: /Gas leak/ }).click()`.

The skill text is [`agent/MAP_SKILL.md`](agent/MAP_SKILL.md); `agent/mcp-probe.mjs` exercises the whole path without an LLM; results of
real agent runs: [DESIGN — The agent layer](docs/DESIGN.md#the-agent-layer-text-snapshot-and-accessibility-mirror).

## Vector tiles without a tile server

```ts
import { routeVectorTiles } from 'geowright/tiles';
await routeVectorTiles(page, '**/vt/buildings/**', { buildings: buildingsGeoJSON }); // key = MVT source-layer
await page.goto('/');                                                                // routes first, then the app
await expect(map).toHaveFeature({ layer: 'buildings' });
```

Real MVT tiles are cut from a GeoJSON fixture inside `page.route`; the app keeps its production `{z}/{x}/{y}.pbf` URL and code path.
`vectorTileHandler(layers)` is the same thing as a plain route handler (for `context.route` or a routing table). `tests/wild/basemap.ts` builds a whole offline basemap this way (style + synthetic city + sprite + glyphs).
For tiled sources the browser cannot know what is off-screen, and the failure messages say so.

## Limits

- **Tested on Chromium** with software WebGL (the flag set MapLibre uses in its own CI; `npx geowright init` writes it).
  Touch gestures beyond `tap` go through CDP — Chromium only.
- **One line in the app is required.** Auto-discovery is not possible for bundled ESM apps (`tests/discovery.spec.ts` proves it).
- **`waitForIdle()` cannot see app-level async** (a fetch that adds a layer later) — use the retrying assertions for that.
- **Tiled sources:** the browser cannot know what is off-screen, and the failure messages say so.
- **On a globe** MapLibre's own viewport-wide query is wrong; the workaround is a grid: an extrusion narrower than 16 px whose
  footprint centre is off-screen can be missed by viewport-wide queries (never mis-clicked; a query `at` it finds it).
- **`hover` on a moving target** is only dependable when frames are short; `click` holds up.
- The injected script is ~135 KB (it bundles MapLibre's style-expression evaluator); test-time only, nothing ships in your app.

The full list, with costs measured on a dense map: [DESIGN — Costs and known limitations](docs/DESIGN.md#costs-and-known-limitations).

## Supported map library versions

Developed against MapLibre GL JS 6. The same small page and the same core specs run against every major below
(`npm run test:compat`, `tests/compat/`, its own CI job; 60 tests). "✓" means asserted by that matrix, not assumed.
Newer public methods are feature-detected, never version-sniffed; what an old version cannot do is said in failure
diagnostics and in the snapshot (`note: …`) instead of being answered wrongly.

**Playwright:** `@playwright/test` 1.49 or later: CI runs the full suite on 1.49.0 (the floor) and on the current
version ([0014](docs/decisions/0014-claim-only-what-is-tested.md)).

| | Mapbox GL JS 1.13 (BSD) | MapLibre 2 | MapLibre 3 | MapLibre 4 | MapLibre 5 | MapLibre 6 |
|---|---|---|---|---|---|---|
| assert: `toHaveFeature`, counts, `where`, `.not` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| act: click / hover / drag on features and locations, click-time verification | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| occlusion by other features and by DOM, `force`, `ignoreLayers` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| visibility from paint evaluation (opacity 0, transparent colour, zero size) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| pixel probe (`toBeVisibleOnMap`, `toHaveLayerPixels`) | ✓ through the frame loop: 3 real frames, may flicker once | ✓ | ✓ | ✓ | ✓ | ✓ |
| text snapshot, evaluated colours, entities | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| markers and popups (`map.marker`, `map.popup`, `toHavePopup`) | ✓ (`mapboxgl-` classes) | ✓ | ✓ | ✓ | ✓ | ✓ |
| vector-tile sources, `routeVectorTiles` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| camera (`toHaveView`), `toHaveGeometry` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| off-screen GeoJSON features: diagnostics, snapshot, `autoPan: true` | ✓ if the source was given an object; a URL: unknowable, and said so | same | same | ✓ | ✓ | ✓ |
| globe projection (far-side refusal, viewport-query workaround) | n/a | n/a | n/a | n/a | not in the matrix | ✓ (main suite) |
| terrain, fill-extrusion lift, touch, drawing tools, the wild apps | not in the matrix | not in the matrix | not in the matrix | not in the matrix | not in the matrix | ✓ (main suite) |

Mapbox GL JS **v2 and later are proprietary and are not tested** (the v1 API family they share makes it likely that most
of this works; nobody here may install them to find out). Style expressions newer than the bundled evaluator are reported
once and treated as visible; styles OLDER than the evaluator are fine.

## Developing geowright

```sh
npm i && npx playwright install chromium
node demo/scripts/copy-worker.mjs      # MapLibre 6 worker files -> demo/public (after a fresh install)
npx playwright test                    # builds the demo, serves it on :4173, runs headless
```

The suite needs no network: everything a page fetches is answered from fixtures (`page.route`), and a non-local request
fails the test. `demo/` is the app under test, `src/inpage/` is injected into the page (adapter seam, engine, MapLibre adapter),
`src/playwright/` is the test-side API, `wild/` holds apps we did not write, `agent/` the Playwright MCP pieces.
Ground rules, the flake bar and the sign-off: [CONTRIBUTING.md](CONTRIBUTING.md).

## Open source, and staying that way

Everything a test verdict depends on is open source under Apache-2.0 and stays that way: the adapter, the engine,
actionability and click-time verification, the matchers, the snapshot and accessibility mirror, diagnostics and failure
artefacts, the offline tile tooling, the agent/MCP integration, and adapters. If paid offerings ever exist they will be
about what happens to results AFTER a run (support, hosted reporting) — never a feature a test needs in order to pass or
fail correctly.

## License

[Apache-2.0](LICENSE) — Copyright 2026 Shai Sinai. See [NOTICE](NOTICE).
The scripts injected into the page bundle MapLibre's style-spec expression evaluator (ISC / BSD-3-Clause) and three
small libraries; their license texts ship in the package as `dist/THIRD_PARTY_LICENSES.txt`, generated from the
bundler's own input list. Everything else this repo uses or vendors: [docs/THIRD_PARTY_NOTICES.md](docs/THIRD_PARTY_NOTICES.md)
and [`wild/README.md`](wild/README.md). Contributions: inbound = outbound, with a DCO sign-off — see
[CONTRIBUTING.md](CONTRIBUTING.md).
