# geowright

Grey-box testing for canvas maps in Playwright. First adapter: MapLibre GL JS 6.
Prototype quality. Design log and honest caveats: the design notes.

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

const map = geowright(page);                       // { mapId?: 'main', timeout?, ignoreLayers?, mirror? }
await map.waitForIdle();

// ASSERT — retrying, like web-first assertions
await expect(map).toHaveFeature({ layer: 'alerts', where: { severity: 'high' } });
await expect(map).not.toHaveFeature({ layer: 'alerts', id: 2 });
await expect(map.features({ layer: 'alerts' })).toHaveFeatureCount(3);
await expect(map).toHaveView({ center: { lng: 35.2, lat: 32.08 }, zoom: 12 });
await expect(map).toHaveFeature({ layer: 'sensors', id: 502 }, { visible: true });   // rendered is not visible
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
{ layer: 'sensors', visible: true }                   // only what the style actually paints (see below)
```

`map.feature(q)` is **strict** (exactly one match, like a Locator); `map.features(q)` is a set.
Handles are lazy: nothing is resolved until an action or assertion runs.

### Rendered is not visible

MapLibre's `queryRenderedFeatures` also returns features painted with opacity 0, a transparent colour, zero
radius/width or `text-opacity: 0` — so a plain `toHaveFeature` can pass on something no user can see.

- `visible: true | false` in any query (or `toHaveFeature(q, { visible: true })`): evaluates the layer's paint
  properties **for that feature** — data-driven expressions, zoom, feature-state — with MapLibre's own expression
  evaluator. Cheap; failure messages say which property (`[NOT VISIBLE: circle-opacity evaluates to 0]`).
- `expect(map.feature(q)).toBeVisibleOnMap()`: the paint check **and** a pixel probe (do the canvas pixels at the
  feature change when its layer is not drawn?). Catches a transparent icon image. The probe re-renders three
  times and toggles the layer within one task — use it where it matters, `{ pixels: false }` skips it.
- Actions refuse an invisible feature by default (`{ force: true }` overrides). Every `FeatureSummary` has
  `visible` / `invisibleBecause`; the snapshot tags `NOT-VISIBLE(...)`.

### What an action waits for (actionability)

1. the query resolves to exactly one feature, and the style actually paints it (not opacity 0 / transparent)
2. the map is not moving, and the target pixel is stable across two frames
3. the pixel is **on** the feature — for polygons an interior point far from the edge, never the centroid
4. the feature is the **topmost hit** at that pixel (its own label on top does not count as an occluder)
5. no DOM element (popup, control, overlay) covers the pixel
6. at the instant the real `pointerdown` arrives, the hit test is re-run; if the target is no longer there the click is swallowed and the action retries

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

It also distinguishes: layer does not exist · layer hidden · feature exists in the source but is off-screen · occluded (names the occluder) · ambiguous (lists the matches). The same text is attached to the HTML report / trace as `map state — …`.

### Geometry and drawing

`toHaveGeometry` compares the feature's **full** geometry as the map's source holds it (rendered geometry is
tile-clipped) against a GeoJSON geometry, a vertex list, or `{ circle: { center, edge } }` — in pixels, ring
start/winding-insensitive. Draw helpers are input choreography, not a binding to one tool: `finish`
(`click-last | click-first | dblclick | enter | none`) and `gesture` (`click-move-click | drag`) are explicit
because draw tools disagree. Tested against terra-draw and mapbox-gl-draw. Note: tools with a drag threshold
(terra-draw: 8px) offset drag-drawn shapes and whole-shape moves by that much — for real users too.

## Agents (Playwright MCP)

Browser agents get an empty `region "Map"` from the accessibility snapshot. Two ways to fix that, both via
Playwright MCP's `--init-script` (no custom MCP server):

```sh
npm run build:inpage      # dist/inpage.js        -> adapter + window.__geowright.snapshot()
npx esbuild src/inpage/agent-entry.ts --bundle --format=iife --outfile=dist/inpage-agent.js   # + accessibility mirror
npx @playwright/mcp --config agent/playwright-mcp.config.json --init-page agent/init-page.ts \
    --init-script dist/inpage.js --caps=vision        # or dist/inpage-agent.js, no caps needed
```

- **Text snapshot** — the agent calls `browser_evaluate` with `window.__geowright.snapshot('main')` (see `agent/MAP_SKILL.md`) and
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
For tiled sources the browser cannot know what is off-screen, and the failure messages say so.

## Determinism

No network. Inline style, GeoJSON sources, raster tiles fulfilled with `page.route`, glyphs served by the app (Noto Sans, OFL). The `map` fixture aborts and fails the test on any non-local request. Headless software WebGL flags (same set MapLibre uses in its own CI) are documented in `playwright.config.ts`.

## Run

```sh
npm i && npx playwright install chromium
node demo/scripts/copy-worker.mjs      # MapLibre 6 worker files -> demo/public (after a fresh install)
npx playwright test                    # builds the demo, serves it on :4173, runs headless
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
tests/            assert / act / draw / draw2 / dense / input / visibility / vector-tiles / two-maps / discovery / snapshot / mirror specs
agent/            Playwright MCP config, init-page hook, skill text, MCP probe + CLI bridge
```
