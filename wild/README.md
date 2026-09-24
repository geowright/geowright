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
| `maplibre-examples/patches/` | one unified diff per example: upstream → vendored. **Must be exactly one added line, the hook.** | | `node wild/scripts/apps.mjs check` checks the committed patches offline; `bash wild/scripts/examples.sh verify` regenerates them from upstream (cached in the git-ignored `.upstream/`; delete it to re-fetch) and checks again |
| `apps/` | real open-source apps (React / Svelte / Vue wrappers), source + prebuilt `dist/` | see each app's LICENSE | `/apps/<name>/` |
| `apps/deck-gl/` | deck.gl's MapLibre `MapboxOverlay` React test app, interleaved WebGL layers | MIT — `apps/deck-gl/LICENSE` | `/apps/deck-gl/` |
| `apps/pmtiles/` | Protomaps' MapLibre example, custom `pmtiles://` vector protocol and byte-range archive reads | BSD-3-Clause — `apps/pmtiles/LICENSE` | `/apps/pmtiles/` |
| `fixtures/` | everything the apps fetch from the network, answered by `page.route` | `fixtures/SOURCES.md` | never served by `serve.mjs`; the tests own the network |

Rules: permissive licenses only, license files kept; the apps are not bent
to fit the library — when something is awkward the LIBRARY changes, or the friction is written down;
no network in tests: an unanswered external request aborts and fails the test, listing the URL.

`node wild/serve.mjs` (port 4174) is started by Playwright (`playwright.config.ts`); specs live in
`tests/wild/`. Basemaps: `DEMOTILES` (recorded, BSD-3 + Natural Earth) and `brightBasemap()` (SYNTHETIC
stand-in for OpenFreeMap "bright", whose OSM data / CC-BY design cannot be committed) — see
`tests/wild/harness.ts` and `tests/wild/basemap.ts`.

`node wild/scripts/apps.mjs check` (run by the unit suite, `tests/unit/wild-apps.unit.spec.ts`) holds every app here to
the rules below: a license file on the allowlist, an `UPSTREAM.md` with the repository, the full commit and the hook
line, a spec that opens it, and a `dist/THIRD_PARTY_LICENSES.md` with the license text of everything `dist/` bundles.
It also fails on a file under `fixtures/` that no row in `fixtures/SOURCES.md` or `fixtures/sources/*.md` names, and holds the
one-line rule to what can be checked without the network ([0016](../docs/decisions/0016-wild-apps-not-bent-checked-offline.md),
proposed): an app's sources name `__geowright_maps` only in the hook line its `UPSTREAM.md` shows, once per file, in the
files it marks "+1 line"; each example's patch is that one added line and nothing else. Whether the REST of a vendored
file is upstream's is not checked offline — for the examples `examples.sh verify` diffs them, for the apps it is review.

## Bring your app

From "my app does not work with geowright" to "it runs in this suite, and the library is fixed". It starts with an
issue from the "My map app does not work" template, which asks for everything below.

1. **Triage.** Is the map library a supported version (README, "Supported map library versions")? Does
   `docs/RECIPES.md` already cover it ("The map never becomes idle", the wrapper hooks)? Can the failure be shown on the
   demo app or on an app already in `wild/`? If so, fix it there — an app is vendored for a failure only it shows. Ask
   in the issue for whatever is missing: the commit, the failing call, what it fetches.
2. **The license.** Read the repository's license file at that commit — the file, not the badge. It must be MIT, BSD,
   ISC, Apache-2.0, CC0, Unlicense or EDL-1.0 ([0015](../docs/decisions/0015-third-party-notices-ship-with-the-copy.md)), and so must
   everything the app's build bundles into `dist/`. Anything else: see "When the license is not on the list" below.
3. **Scaffold.** `node wild/scripts/apps.mjs new <name> <repository-url> <full-commit-sha> <path/to/upstream/LICENSE>`
   reads the license text and refuses anything off the list, before writing a byte. Then it writes
   the license file (byte-identical, same name) and `UPSTREAM.md` in `apps/<name>/`, `fixtures/sources/<name>.md`, a row in
   `fixtures/SOURCES.md` and `tests/wild/<name>.spec.ts`, and never overwrites. Every `TODO(new-app)` in them is a
   question to answer; `check` (and so the unit suite) fails until none is left.
4. **Vendor, plus ONE line.** Copy the app's files from that commit into `apps/<name>/` unchanged — as few as the
   failure needs: one example, not the monorepo. Add exactly one line, the hook
   ([0010](../docs/decisions/0010-wild-apps-not-bent.md)). Our own build files (`package.json`, the bundler config,
   an `index.html` if upstream has none) sit beside them; build with `npm ci && npm run build` and commit `dist/`, which
   `serve.mjs` serves at `/apps/<name>/`. `dist/` redistributes what the build bundles, so it carries their notices:
   in the Vite config, `build: { license: { fileName: 'THIRD_PARTY_LICENSES.md' } }`; a build that only copies files
   writes the same file itself (`apps/pmtiles/scripts/build.mjs`). A bundled package that ships no license file gets
   its text added by the build (`apps/svelte-maplibre-gl/vite.config.js`); `check` fails on a section without one. `UPSTREAM.md` lists every vendored path and shows the one line as a diff.
5. **Fixtures for everything it fetches.** Run the spec
   (`npx playwright test tests/wild/<name>.spec.ts`): the harness aborts every request to the outside and fails the
   test naming each URL. Answer each one with a route, from what exists first — `DEMOTILES`, `glyphs()`,
   `rasterTiles()` (`tests/wild/harness.ts`), the synthetic basemaps (`tests/wild/basemap.ts`) — then with generated
   data, or a permissively licensed file kept with its license. Never OpenStreetMap-derived data (ODbL), CC-BY assets,
   or vendor tiles; an API key stays in the app's source and the route answers it. One row per fixture in
   `fixtures/sources/<name>.md`.
6. **The failing spec first.** Write the geowright call from the issue into the spec and watch it fail the way the
   report says, before `src/` changes. That failure is the evidence the fix is measured against.
7. **Fix the library, never the app.** When the app is awkward to test, geowright changes, or the friction is
   written down in the issue and `UPSTREAM.md`. The spec passes; a change to waiting, input or timing also passes
   `--repeat-each=20`; `node wild/scripts/apps.mjs check` passes; the issue gets the report (AGENTS.md, *What "done" means*).

### When the license is not on the list

GPL, LGPL, AGPL, MPL, CC-BY in any form, ODbL, a choice of licenses none of whose options is on the list, or no license at all
(which means all rights reserved): the app cannot be vendored, in whole or in part, and the helper refuses it. The
report still counts. Help happens in the issue — the snapshot, the failing call, the fix if it is in geowright. If
the failure can be reproduced by a page written from scratch (on the demo app or a new first-party page under
`tests/`, never a copy of their code), that page carries the failing spec instead. What made the app hard to test is
written down in the issue, so the friction is not lost with the app. A dual license whose every option is on the list
(`MIT OR Apache-2.0`, as `apps/svelte-maplibre-gl/`) is fine: keep both files. A choice where only some options are on
the list (`MIT OR GPL-3.0`) is fine too, for an app as for a dependency inside a bundle: it is used under an option on
the list, UPSTREAM.md (or the notices) says so, and only that option's license file is vendored — JSTS, `EDL-1.0 OR
EPL-1.0`, inside the Turf fixture, is used under EDL-1.0 ([0015](../docs/decisions/0015-third-party-notices-ship-with-the-copy.md)).
The helper recognises license files, not choices: it refuses a file off the list, so the election is a person's.
