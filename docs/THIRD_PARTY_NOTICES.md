# Third-party notices

Every entry below was checked against the installed package's `node_modules/<pkg>/package.json`
("license"/"version" fields) and its `LICENSE`/`NOTICE` file on 2026-09-20. Versions are what is
currently installed (see `package.json` / `package-lock.json`); pin dates if you regenerate this
file after a dependency bump.

None of the licenses below are copyleft, and none conflict with distributing the core under
Apache-2.0. Nothing outside MIT / BSD-2-Clause / BSD-3-Clause /
ISC / OFL-1.1 was found.

---

## 1. Bundled into the published package / injected into pages

This is what actually ships inside `dist/inpage.js` and `dist/inpage-agent.js` (the scripts injected
into the page under test) and `dist/index.js` / `dist/tiles.js` (the Node-side package a consumer
installs). Determined from `package.json` `"files"`/`"dependencies"` and from what `src/inpage/*.ts`
and `src/playwright/*.ts` actually `import` (not `import type`, which esbuild/tsc erase before
bundling).

**`maplibre-gl` is a devDependency only and is *not* bundled.** `src/inpage/maplibre-adapter.ts` and
`src/inpage/maplibre-paint.ts` import `Map`, `GeoJSONSource`, `MapGeoJSONFeature` from it, but every
one of those is `import type { ... }` — erased at compile time. Confirmed by grepping the built
`dist/inpage.js`: no maplibre-gl runtime code, no license banner, no `mapboxgl`-style API surface
present. A consumer's own page supplies its own maplibre-gl instance; this library only calls into
it via the DOM/JS handle at runtime.

**`@maplibre/maplibre-gl-style-spec` IS bundled at runtime.**
`src/inpage/maplibre-paint.ts` does `import { expression as styleExpression, latest,
normalizePropertyExpression, type StylePropertyExpression } from '@maplibre/maplibre-gl-style-spec'`
— a real (non-type) import of the expression evaluator, used to compute paint-property colours
client-side. Verified present in `dist/inpage.js` by grepping for symbols unique to its transitive
deps (`quickselect`, `tinyqueue`, `unitbezier` all matched; `jsonlint`, `minimist`,
`json-stringify-pretty-compact` — used only by the style-spec's *validator*, not its evaluator — did
not, i.e. tree-shaken out of this particular build). Re-checked from esbuild's metafile
on 2026-09-20: the same four packages, nothing else from `node_modules`.

| Package | Version | SPDX | Copyright | Notice required? |
|---|---|---|---|---|
| `@maplibre/maplibre-gl-style-spec` | 26.4.4 | ISC | `Copyright (c) 2020, MapLibre contributors` (LICENSE.txt also carries `Copyright (c) 2020, Mapbox` BSD-3-Clause for inherited mapbox-gl-js ≤v1.13 code, `Copyright (C) 2011 by Evan Wallace` MIT for glfx.js, `Copyright 2010-2016 Mike Bostock` BSD-3-Clause for d3-color) | Yes (ISC + BSD + MIT all require notice) |

Transitive runtime deps of `@maplibre/maplibre-gl-style-spec` (from its own `package.json`
`"dependencies"`) — listed because the evaluator that IS bundled pulls from this set; whether each
one individually survives tree-shaking in a given build was checked above only for the ones grepped:

| Package | Version | SPDX | Copyright | Notice required? |
|---|---|---|---|---|
| `@mapbox/jsonlint-lines-primitives` | 2.0.3 | MIT | `Copyright (c) 2012 Zachary Carter` | Yes (style validator only — not observed in the current `dist/inpage.js`) |
| `@mapbox/unitbezier` | 1.0.0 | BSD-2-Clause | `Copyright (C) 2008 Apple Inc. All Rights Reserved.` | Yes — observed in `dist/inpage.js` |
| `json-stringify-pretty-compact` | 4.0.0 | MIT | `Copyright (c) 2014, 2016, 2017, 2019, 2021, 2022 Simon Lydell` | Yes (not observed in current build) |
| `minimist` | 1.2.8 | MIT | No named copyright holder in LICENSE text; `package.json` author is James Halliday (substack) | Yes (not observed in current build) |
| `quickselect` | 3.0.0 | ISC | `Copyright (c) 2024, Vladimir Agafonkin` | Yes — observed in `dist/inpage.js` |
| `tinyqueue` | 3.0.0 | ISC | `Copyright (c) 2017, Vladimir Agafonkin` | Yes — observed in `dist/inpage.js` |

**How the attribution travels with the artifact:** esbuild strips ordinary comments, and none of these
packages marks its license comment as a legal one, so `--legal-comments` alone ships nothing (checked:
zero `Copyright` matches in the built file). Instead `npm run build` runs
`scripts/third-party-licenses.mjs`, which reads esbuild's metafile — the list of inputs that actually
survived tree-shaking — and writes the full license text of each bundled package to
`dist/THIRD_PARTY_LICENSES.txt` (in `"files"`, next to the bundles, whose first line is a `/*! … */`
banner pointing at it). Today that is exactly four packages: the style-spec, `@mapbox/unitbezier`,
`quickselect`, `tinyqueue`. The root `NOTICE` names the same four. The style-spec vendors its three
dependencies pre-built inside its own `dist/`, without their `package.json`; the script takes their
license files from the installed top-level copies.

---

## 2. Runtime dependencies installed alongside (Node-side, `package.json` `"dependencies"`)

Used by `src/playwright/tiles.ts` (the `./tiles` export, for building vector-tile fixtures in
Node — a consumer's test runner, not the browser). Confirmed by grep: `tiles.ts` imports
`GeoJSONVT` from `@maplibre/geojson-vt` and `fromGeojsonVt` from `@maplibre/vt-pbf`.
`@types/geojson` is types-only (no runtime footprint, but listed for completeness / attribution
since its LICENSE is bundled by some SBOM tools regardless).

| Package | Version | SPDX | Copyright | Notice required? |
|---|---|---|---|---|
| `@maplibre/geojson-vt` | 6.1.1 | ISC / MIT (dual notice in one LICENSE file) | `Copyright (c) 2025 MapLibre contributors` (MIT, current code) + `Copyright (c) 2024, Mapbox` (ISC, inherited) | Yes |
| `@maplibre/vt-pbf` | 4.3.2 | MIT | `Copyright (c) 2025 MapLibre contributors` + `Copyright (c) 2015 Anand Thakker` (for inherited `geojson_wrapper.js`, additionally BSD-3-Clause `Copyright (c) 2014, Mapbox`) | Yes |
| `@types/geojson` | 7946.0.16 | MIT | `Copyright (c) Microsoft Corporation.` | Yes (types-only; no runtime code shipped) |

**`peerDependencies`**: `@playwright/test` `>=1.49.0` — Apache-2.0, Microsoft Corporation. Not
bundled; the consumer supplies their own copy. See §3 for the installed dev copy's details.

---

## 3. Dev / test-only material (not shipped in the published package)

### Build & test tooling (`devDependencies`)

| Package | Version | SPDX | Copyright | Ships in package? |
|---|---|---|---|---|
| `maplibre-gl` | 6.10.0 | BSD-3-Clause | `Copyright (c) 2023, MapLibre contributors` | No — devDependency/peer-style usage only, type-only import (see §1) |
| `terra-draw` | 1.34.0 | MIT | No LICENSE file ships in the npm tarball; `package.json` names author James Milner (`JamesLMilner/terra-draw`) | No — demo app only |
| `terra-draw-maplibre-gl-adapter` | 1.4.1 | MIT | Same as above (no bundled LICENSE file; same author/repo) | No — demo app only |
| `@mapbox/mapbox-gl-draw` | 1.5.2 | ISC | `Copyright (c) Mapbox` (no year in LICENSE) | No — demo app only (`demo/draw2.html`) |
| `esbuild` | 0.28.2 | MIT | `Copyright (c) 2020 Evan Wallace` | No — build tool |
| `vite` | 8.3.0 | MIT | `Copyright (c) 2019-present, VoidZero Inc. and Vite contributors` | No — build tool |
| `typescript` | 7.0.2 | Apache-2.0 | Microsoft Corporation (LICENSE + NOTICE.txt, the latter listing TypeScript's own third-party notices) | No — build tool |
| `@playwright/test` | 1.63.0 | Apache-2.0 | `Copyright (c) Microsoft Corporation` (NOTICE: contains code derived from Puppeteer, also Apache-2.0) | No — test runner, peer dependency; consumer installs their own |
| `@playwright/mcp` | 0.0.82 | Apache-2.0 | Microsoft Corporation | No — agent/dev tooling only (`agent/`) |
| `@types/node` | 26.6.2 | MIT | `Copyright (c) Microsoft Corporation.` | No — types only |

### Map library versions for the compat matrix (`tests/compat`, devDependencies under npm aliases)

Installed only so that the version matrix can load them in a browser; never bundled, never shipped.

| Alias → package | Version | SPDX | Copyright | Ships in package? |
|---|---|---|---|---|
| `mapbox-gl-1` → `mapbox-gl` | **1.13.3, pinned exactly** | BSD-3-Clause (`package.json` says "SEE LICENSE IN LICENSE.txt"; the text was read: 3-clause BSD) | `Copyright (c) 2020, Mapbox` | No |
| `maplibre-gl-2` … `maplibre-gl-5` → `maplibre-gl` | 2.4.0, 3.6.2, 4.7.1, 5.24.0 | BSD-3-Clause | MapLibre contributors | No |

**mapbox-gl v2 and later are proprietary (Mapbox Terms of Service) and must never be installed here.** The
unaliased `mapbox-gl` entry in the lockfile is the same 1.13.3, pulled in as the peer of
`@mapbox/mapbox-gl-supported`, whose peer range is `<2.0.0`. `npm audit` reports an advisory against the old
MapLibre majors (HTML sanitising in popups): they are test targets loaded from localhost with fixture
data, which is the point of a version matrix — not fixed, not shipped.

`lightningcss` (MPL-2.0, a dependency of Vite) is the one non-permissive licence in the lockfile: a
build tool that is executed, never copied, modified or distributed by this project.

### Fonts (demo app)

| What | License | Source | Ships? |
|---|---|---|---|
| Noto Sans Regular, glyph range 0–255 (`demo/public/glyphs/Noto Sans Regular/0-255.pbf`) | SIL Open Font License 1.1 | Google's Noto fonts; prebuilt SDF PBF fetched from `maplibre/demotiles` (`font/Noto Sans Regular/0-255.pbf`), 2026-09-20 — see `demo/public/glyphs/README.md` | No — demo-app fixture only, not part of `"files"` |

### Vendored maplibre-gl build (demo app, checked into git)

`demo/public/maplibre/maplibre-gl-shared.mjs` (514 KB) and `maplibre-gl-worker.mjs` (19 KB) are a
prebuilt MapLibre GL JS dev bundle served directly to the demo app; the shared file's own embedded
header reads `/** MapLibre GL JS * @license 3-Clause BSD ... v6.10.0 ... */`. Demo-only, not in
`package.json` `"files"`.

### `wild/` — apps, examples and fixtures we did not write

| Vendored app | Upstream and license | Notice kept in tree |
|---|---|---|
| `wild/apps/deck-gl/` | `visgl/deck.gl` at `b28503d8742e3551a37372b9cb911aa1cc9b6706`, MIT, Copyright Vis.gl contributors | `wild/apps/deck-gl/LICENSE`; one-line map hook shown in `UPSTREAM.md` |
| `wild/apps/pmtiles/` | `protomaps/PMTiles` at `aec8fa1341222fdddb3318e9ffa8e18e19b312f7`, BSD-3-Clause, Copyright 2021 Protomaps LLC | `wild/apps/pmtiles/LICENSE`; copied MapLibre/fflate bundle licenses in `dist/vendor/`; one-line map hook shown in `UPSTREAM.md` |

Full inventory and per-item licensing already tracked in `wild/README.md` (the table of
`maplibre-examples/`, `apps/`, `fixtures/`) and `wild/fixtures/SOURCES.md` (per-fixture origin,
license and size) — referenced here rather than duplicated so the two don't drift. Summary:
everything vendored there is stated permissive/public-domain by policy ("Rules ... permissive
licenses only, license files kept" — `wild/README.md`), e.g. MapLibre's own examples (BSD-3-Clause),
`demotiles` fixtures (BSD-3-Clause + Natural Earth public domain), USGS earthquake data (US
government work, public domain), and `wild/apps/react-map-gl` (has its own `LICENSE` file in-tree).
None of this ships in the npm package (confirmed: `npm pack --dry-run` includes nothing under
`wild/`, `tests/`, or `demo/` — see the pack review below).

---

## Flags

- **Nothing found outside MIT / BSD-2-Clause / BSD-3-Clause / ISC / Apache-2.0 / SIL OFL-1.1.** No
  GPL/LGPL/AGPL/SSPL/BSL or other copyleft or source-available license anywhere in
  `node_modules` for the packages audited, nor in `wild/`'s stated licenses.
- `terra-draw` and `terra-draw-maplibre-gl-adapter` declare `"license": "MIT"` in `package.json` but
  do **not** ship a `LICENSE` file in the installed npm package — there is no copyright-holder line
  to copy verbatim beyond the package.json `author` field (James Milner). Not a blocker (MIT doesn't
  require a bundled LICENSE file to be valid), but if exact attribution text is wanted, pull it from
  the `JamesLMilner/terra-draw` GitHub repo's root `LICENSE` rather than the npm tarball.
- `minimist`'s bundled `LICENSE` text has no named copyright holder (generic "This software is
  released under the MIT license"); the `package.json` `author` is James Halliday. Transitive-only,
  dev-side (style-spec validator, not observed in the built `dist/inpage.js`).
- None of the above is incompatible with distributing the core under Apache-2.0.
