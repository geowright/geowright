# 0020. Third-party material: the allowlist adds 0BSD and the Unicode data license; notices still ship with every copy

- Status: Proposed
- Date: 2026-09-25
- Decided by: Shai Sinai
- Supersedes: 0015

## Decision
Third-party code or data is used only under MIT, BSD (including 0BSD), ISC, Apache-2.0, CC0, Unlicense, EDL-1.0 (the
Eclipse Distribution License, a BSD-3-Clause text), the Unicode data license (Unicode-DFS-2016 and its successor
Unicode-3.0, for data derived from the Unicode Character Database), OFL for fonts, or in the public domain (Natural
Earth; US government works such as USGS data). A choice of licenses (`A OR B`) is fine when one option is on this list:
it is used under that option, and the notice says so. Every committed copy of third-party material, bundled or minified
or converted, has the copyright notice and license text of everything in it beside it. No OpenStreetMap-derived (ODbL)
data, no CC-BY assets, no vendor map tiles, nothing from anyone's employer.

## Why
MapLibre's prebuilt dist, committed in the demo and in the wrapper apps, bundles code under two licenses the list did
not name: `bidi-js`, whose tables are derived from the Unicode Character Database (Unicode's data license: permissive,
the notice must appear with every copy), and, in the 5.x and 3.x builds, `tslib` (0BSD: permissive, no notice required).
Both are as permissive as the licenses already listed. The rest of 0015 is unchanged.

## Consequences
- easy: MapLibre's own dist can be committed as it is, with its notices; the list names what is actually shipped
- costs: none beyond 0015's; the Unicode notice is carried like any other (`demo/public/maplibre/THIRD_PARTY_LICENSES.md`)
- enforced by: as 0015; `demo/scripts/copy-worker.mjs` writes the demo copy's notices from MapLibre's source maps and
  fails on a bundled package without a license text or a copied source file with an unknown copyright line

## More
- 0015 (superseded when this is accepted), 0008
- docs/THIRD_PARTY_NOTICES.md, wild/fixtures/SOURCES.md; CONTRIBUTING.md "Licenses" (to be updated on acceptance)
