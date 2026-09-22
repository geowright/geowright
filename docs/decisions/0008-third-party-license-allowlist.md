# 0008. Third-party material: a strict license allowlist

- Status: Accepted
- Date: 2026-09-20
- Decided by: Shai Sinai

## Decision
Third-party code or data is used only under MIT, BSD, ISC, Apache-2.0, CC0, Unlicense, or OFL
for fonts. Its license is kept and attributed in `docs/THIRD_PARTY_NOTICES.md` or the relevant
`SOURCES.md`. No OpenStreetMap-derived (ODbL) data, no CC-BY assets, no vendor map tiles, and
nothing from anyone's employer.

## Why
The injected test-time script bundles third-party code, and the test apps under `wild/` vendor
third-party fixtures — both need a license story that clears a corporate legal review without
argument, which rules out copyleft and rules out attribution terms heavier than "keep the notice".
ODbL is named specifically because a real-looking map basemap is the single most tempting
exception, and the easiest one to get wrong by accident.

## Consequences
- easy: every dependency and vendored fixture already clears corporate procurement; a generated notices list ships with the package
- costs: no OpenStreetMap-derived basemap can be committed as a fixture — realism has to come from synthetic data or a differently-licensed source
- enforced by: CONTRIBUTING.md "Licenses"; `docs/THIRD_PARTY_NOTICES.md` generated from the bundler's own input list; not enforced by an automated license scanner in this repository

## More
- CONTRIBUTING.md
- README.md "License"
- docs/THIRD_PARTY_NOTICES.md
