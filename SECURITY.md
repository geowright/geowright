# Security

## The test hook exposes your map instance — use it in test/dev builds only

geowright needs one line in the app:

```js
(window.__geowright_maps ??= {}).main = map;
```

That line makes the `maplibregl.Map` instance reachable by **any script running on the page**:
third-party tags, browser extensions, injected ads. With the instance a script can read every
rendered feature and its properties (including data your UI never displays), read source data of
GeoJSON sources, change the style, and move the camera. `docs/DESIGN.md` records an AI agent
discovering the global on its own and mining it — useful in tests, not something to ship.

- Guard it: `if (import.meta.env.MODE !== 'production') { ... }` (or your bundler's equivalent), and
  check that the line is absent from production bundles.
- geowright itself ships nothing in your app: the in-page adapter is injected by Playwright at test
  time (`page.evaluate`), only in the browser the test controls.
- The accessibility mirror (`{ mirror: true }`) adds invisible buttons to the page under test. Test
  sessions only.
- `routeVectorTiles` / fixtures run in the test process; they never open a port.

## Old MapLibre versions in this repository are test fixtures
The repository installs old `maplibre-gl` majors (v2–v5, under aliases such as `maplibre-gl-5`) and
keeps the example apps under `wild/` at their upstream versions, on purpose: the suite tests the
versions people actually run. Some of those versions have known advisories (for example
GHSA-jrc7-96c5-q579, fixed only in 6.4.1). They run only inside the test suite, against local
fixture pages; the published package neither ships nor depends on `maplibre-gl` (see
`package.json` `dependencies` and `files`), and `wild/` is not part of it.

## Reporting a vulnerability
Please do not open a public issue for a security problem. Use GitHub's private vulnerability reporting
on this repository (**Security → Report a vulnerability**). You will get an answer within a week.
geowright is a test-time library with no server side: the realistic classes of problem are the hook
described above, the injected script doing something it should not in the page under test, and the
supply chain of what is bundled (`dist/THIRD_PARTY_LICENSES.txt` lists exactly what that is).
