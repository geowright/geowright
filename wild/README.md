# wild/ — MapLibre apps we did not write

geowright's own demo app was written by the same author as the library, with the library's assumptions
baked in. This directory holds apps written by people who never heard of it, vendored under their own
licenses, each made testable with **the one-line hook and nothing else**:

```js
(window.__geowright_maps ??= {}).main = map;
```

| | what | license | how it is served |
|---|---|---|---|
| `maplibre-examples/examples/` | MapLibre GL JS's own examples (`maplibre/maplibre-gl-js`, tag v6.10.0, `test/examples/`) | BSD-3-Clause — `maplibre-examples/LICENSE.txt` | as-is at `/test/examples/<name>.html`; their `../../dist/maplibre-gl-dev.mjs` import resolves to `node_modules/maplibre-gl/dist` |
| `maplibre-examples/patches/` | one unified diff per example: upstream → vendored. **Must be exactly one added line.** | | `bash wild/scripts/examples.sh verify` re-fetches upstream and checks |
| `apps/` | real open-source apps (React / Svelte / Vue wrappers), source + prebuilt `dist/` | see each app's LICENSE | `/apps/<name>/` |
| `fixtures/` | everything the apps fetch from the network, answered by `page.route` | `fixtures/SOURCES.md` | never served by `serve.mjs`; the tests own the network |

Rules: permissive licenses only, license files kept; the apps are not bent
to fit the library — when something is awkward the LIBRARY changes, or the friction is written down;
no network in tests: an unanswered external request aborts and fails the test, listing the URL.

`node wild/serve.mjs` (port 4174) is started by Playwright (`playwright.config.ts`); specs live in
`tests/wild/`. Basemaps: `DEMOTILES` (recorded, BSD-3 + Natural Earth) and `brightBasemap()` (SYNTHETIC
stand-in for OpenFreeMap "bright", whose OSM data / CC-BY design cannot be committed) — see
`tests/wild/harness.ts` and `tests/wild/basemap.ts`.
