# Security (DRAFT)

## The test hook exposes your map instance — use it in test/dev builds only

geowright needs one line in the app:

```js
(window.__geowright_maps ??= {}).main = map;
```

That line makes the `maplibregl.Map` instance reachable by **any script running on the page**:
third-party tags, browser extensions, injected ads. With the instance a script can read every
rendered feature and its properties (including data your UI never displays), read source data of
GeoJSON sources, change the style, and move the camera. an earlier phase of `the design notes` records an AI agent
discovering the global on its own and mining it — useful in tests, not something to ship.

- Guard it: `if (import.meta.env.MODE !== 'production') { ... }` (or your bundler's equivalent), and
  check that the line is absent from production bundles.
- geowright itself ships nothing in your app: the in-page adapter is injected by Playwright at test
  time (`page.evaluate`), only in the browser the test controls.
- The accessibility mirror (`{ mirror: true }`) adds invisible buttons to the page under test. Test
  sessions only.
- `routeVectorTiles` / fixtures run in the test process; they never open a port.

## Reporting a vulnerability
Report vulnerabilities through GitHub Security Advisories.
