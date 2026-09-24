# Fixtures for `measure-distances`

| file | what the app asked for | origin / license / evidence | size | sha256 |
|---|---|---|---|---|
| `wild/fixtures/vendor/turf@7/turf.min.js` | `https://cdn.jsdelivr.net/npm/@turf/turf@7/turf.min.js` | `@turf/turf` npm package (unpinned `@7` resolved to `7.4.0` at fetch time, confirmed via the `x-jsd-version` response header), **MIT**; browser UMD bundle (`package.json` `"browser": "turf.min.js"`), self-contained (no further imports) | 547 KB | — |
| `wild/fixtures/vendor/turf@7/LICENSE` | (license file for the above, not itself fetched by the app) | `https://unpkg.com/@turf/turf@7/LICENSE`, same package/version family; byte-identical to the `LICENSE` in the `@turf/turf` 7.4.0 npm tarball (as is `turf.min.js`), checked 2026-09-24 | 1.1 KB | — |
| `wild/fixtures/vendor/turf@7/THIRD_PARTY_LICENSES.md` | (notices for the above, not fetched by the app) | the license texts of what `turf.min.js` bundles besides Turf itself, each from its npm tarball: JSTS 2.7.1 `(EDL-1.0 OR EPL-1.0)`, used under **EDL-1.0** (a BSD-3-Clause text; jsts ships no license file, so the Eclipse Foundation's text is taken from `paho-mqtt` 1.1.0's `edl-v10`), and MIT / ISC / BSD-2-Clause / BSD-3-Clause / Unlicense dependencies (`d3-*`, `rbush`, `earcut`, `concaveman`, `polyclip-ts`, `topojson-*`, …). Written 2026-09-24 | 32 KB | — |

Basemap: `https://tiles.openfreemap.org/styles/bright` — served by `brightBasemap(center)` (synthetic
stand-in, see `tests/wild/basemap.ts`), not a new fixture.
