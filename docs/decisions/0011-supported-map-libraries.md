# 0011. Supported map libraries: MapLibre 2-6 and Mapbox v1

- Status: Accepted
- Date: 2026-09-20
- Decided by: Shai Sinai

## Decision
The supported map libraries are MapLibre GL JS versions 2 through 6, and Mapbox GL JS 1.13 —
the last BSD-licensed release, sharing the v1 API family with MapLibre. No adapters exist yet for
any other map library.

## Why
MapLibre 6 is the primary development target; a version matrix exists because claiming support
only for the newest version would silently exclude most production apps today. Mapbox 1.13 is the
ceiling specifically because it is the last permissively licensed release sharing that API shape —
later Mapbox majors are proprietary, and nobody working on this project may install them to verify
anything against them. This rules out claiming support for a version never actually run in CI.

## Consequences
- easy: the compatibility claim in the README is something CI actually asserts, run against every version in the matrix, not a guess
- costs: newer public methods must be feature-detected rather than version-sniffed, so an old version's limits show up as a diagnostic rather than a wrong answer
- enforced by: the compatibility suite as its own CI job; not enforced beyond that, which is why claims are re-checked separately (see the record on claiming only what is tested)

## More
- README.md "Supported map library versions"
- docs/DESIGN.md "Version compatibility"
- tests/compat/
