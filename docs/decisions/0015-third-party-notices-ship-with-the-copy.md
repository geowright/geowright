# 0015. Third-party material: the allowlist, and its notices ship with every copy

- Status: Proposed
- Date: 2026-09-24
- Decided by: Shai Sinai (to accept or reject)
- Supersedes: 0008

## Decision
Third-party code or data is used only under MIT, BSD, ISC, Apache-2.0, CC0, Unlicense, EDL-1.0 (the
Eclipse Distribution License, a BSD-3-Clause text), OFL for fonts, or in the public domain (Natural
Earth; US government works such as USGS data). A choice of licenses (`A OR B`) is fine when one option
is on this list: it is used under that option, and the notice says so (JSTS: EDL-1.0, not EPL-1.0).
Every committed copy of third-party material, bundled or minified or converted, has the copyright
notice and license text of everything in it beside it. No OpenStreetMap-derived (ODbL) data, no CC-BY
assets, no vendor map tiles, nothing from anyone's employer.

## Why
0008 kept the allowlist but not the notices: the wrapper apps' `dist/`, the vendored Turf bundle (which
contains JSTS), the demo's MapLibre build and its Noto glyphs were committed, and so would be published,
without the texts MIT, ISC, BSD and the OFL require in every copy. 0008 also did not name the public-domain
data the fixtures already use, nor EDL-1.0, and its "generated" notices list covered the package only.

## Consequences
- easy: a copy of the repository is a compliant redistribution by itself; a new app or fixture states its notices where it lands
- costs: every wrapper-app build writes `dist/THIRD_PARTY_LICENSES.md`, and a bundle's notices are checked by reading it, not by trusting its one license line
- enforced by: the package's `dist/THIRD_PARTY_LICENSES.txt` is generated from esbuild's input list (`scripts/third-party-licenses.mjs`); `node wild/scripts/apps.mjs check`, run by the unit suite, fails on a wild app whose license is off the list or whose `dist/` has no notices file or a package in it without a text, and on a file under `wild/fixtures/` that no `SOURCES.md` row names; `docs/THIRD_PARTY_NOTICES.md` and the notices under `demo/public/` are kept by hand, not checked

## More
- 0008 (superseded), 0010
- docs/THIRD_PARTY_NOTICES.md, wild/fixtures/SOURCES.md, wild/README.md "Bring your app"
- CONTRIBUTING.md "Licenses"
