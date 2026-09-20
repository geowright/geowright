# mapwright (working name — taken on npm, see the design notes)

Grey-box testing for canvas maps in Playwright. First adapter: MapLibre GL JS 6.
Spike quality. Not published. Design log and honest caveats: the design notes.

Closes two gaps a DOM-only Playwright suite has on a WebGL map:

- **ASSERT** — after an action in the normal UI, verify something was added to / changed on / removed from the map.
- **ACT** — perform actions that start on the map: click a feature, right-click a location, draw, drag a vertex.

Actions are **real input** (`page.mouse` at projected pixels), never `map.fire()`. The adapter uses MapLibre's **public API only**.

## App side: one line, no dependency

```ts
const map = new maplibregl.Map({ ... });
(window.__mapwright_maps ??= {}).main = map;   // that's it; nothing is imported, nothing ships
```

The in-page adapter is injected by Playwright at test time. (Auto-discovery is not possible for bundled ESM apps — `tests/discovery.spec.ts` proves it.)

## Test side

```ts
import { mapwright, expect } from '../src/playwright';

const map = mapwright(page);                       // { mapId?: 'main', timeout?, ignoreLayers? }
await map.waitForIdle();

// ASSERT — retrying, like web-first assertions
await expect(map).toHaveFeature({ layer: 'alerts', where: { severity: 'high' } });
await expect(map).not.toHaveFeature({ layer: 'alerts', id: 2 });
await expect(map.features({ layer: 'alerts' })).toHaveFeatureCount(3);
await expect(map).toHaveView({ center: { lng: 35.2, lat: 32.08 }, zoom: 12 });

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
```

`map.feature(q)` is **strict** (exactly one match, like a Locator); `map.features(q)` is a set.
Handles are lazy: nothing is resolved until an action or assertion runs.

### What an action waits for (actionability)

1. the query resolves to exactly one feature
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

## Agents (Playwright MCP)

Browser agents get an empty `region "Map"` from the accessibility snapshot. Two ways to fix that, both via
Playwright MCP's `--init-script` (no custom MCP server):

```sh
npm run build:inpage      # dist/inpage.js        -> adapter + window.__mapwright.snapshot()
npx esbuild src/inpage/agent-entry.ts --bundle --format=iife --outfile=dist/inpage-agent.js   # + accessibility mirror
npx @playwright/mcp --config agent/playwright-mcp.config.json --init-page agent/init-page.ts \
    --init-script dist/inpage.js --caps=vision        # or dist/inpage-agent.js, no caps needed
```

- **Text snapshot** — the agent calls `browser_evaluate` with `window.__mapwright.snapshot('main')` (see `agent/MAP_SKILL.md`) and
  clicks the listed client pixels with `browser_mouse_click_xy`. Most efficient in our runs.
- **Accessibility mirror** — features appear in the normal `browser_snapshot` as buttons; normal `browser_click` works
  (a real click that bubbles to the map, like a MapLibre Marker). Zero instructions. Also usable from tests:
  `page.getByRole('button', { name: /Gas leak/ }).click()`.

`agent/mcp-probe.mjs` exercises the whole path without an LLM; results of real agent runs are in the design notes (an earlier phase).

## Vector tiles without a tile server

```ts
import { routeVectorTiles } from 'mapwright-spike/tiles';
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
npm run pack:local                     # dist/mapwright-spike-0.0.0.tgz for trying it in another project (for local testing)
```

## Layout

```
demo/             the system under test (Vite + MapLibre 6 + terra-draw), no test code inside
src/inpage/       injected into the page: adapter seam (types.ts), engine (library-agnostic), MapLibre adapter
src/playwright/   mapwright(page), handles, expect matchers
tests/            assert / act / draw / input / vector-tiles / two-maps / discovery / snapshot / mirror specs
agent/            Playwright MCP config, init-page hook, skill text, MCP probe + CLI bridge
```
