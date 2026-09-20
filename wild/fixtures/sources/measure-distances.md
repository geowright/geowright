# Fixtures for `measure-distances`

| file | what the app asked for | origin / license / evidence | size | sha256 |
|---|---|---|---|---|
| `wild/fixtures/vendor/turf@7/turf.min.js` | `https://cdn.jsdelivr.net/npm/@turf/turf@7/turf.min.js` | `@turf/turf` npm package (unpinned `@7` resolved to `7.4.0` at fetch time, confirmed via the `x-jsd-version` response header), **MIT**; browser UMD bundle (`package.json` `"browser": "turf.min.js"`), self-contained (no further imports) | 547 KB | — |
| `wild/fixtures/vendor/turf@7/LICENSE` | (license file for the above, not itself fetched by the app) | `https://unpkg.com/@turf/turf@7/LICENSE`, same package/version family | 1.1 KB | — |

Basemap: `https://tiles.openfreemap.org/styles/bright` — served by `brightBasemap(center)` (synthetic
stand-in, see `tests/wild/basemap.ts`), not a new fixture.
