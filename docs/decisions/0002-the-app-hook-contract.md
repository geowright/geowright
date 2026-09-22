# 0002. The app hook contract

- Status: Proposed
- Date: 2026-09-22
- Decided by: Shai Sinai

## Decision
An app exposes its map instance as `(window.__geowright_maps ??= {}).<name> = map`.
Nothing is imported and nothing ships in the app; the test-time adapter is injected separately.
The shape is frozen from 0.1.0: changing it later breaks every user's app code.

## Why
The hook lives in users' application source, not in a dependency they can upgrade.
That makes it the single most expensive contract this project can change: a rename or
reshape after release is a breaking change in code this project does not own or control.
Auto-discovery was considered and rejected — a bundled app gives no reliable back-reference
from a rendered map instance to find automatically. The hook also makes the map instance
reachable by any script on the page, so it is documented as test/dev-only, never for production.

## Consequences
- easy: works with any bundler or framework wrapper with one added line; no dependency to install in the app
- costs: the global's name and shape are now permanent API surface; cannot be silently renamed
- enforced by: not enforced by a check — an app can leave the line in a production build; this is a documented risk, not a gate

## More
- README.md "App side: one line, no dependency"
- SECURITY.md
- docs/DESIGN.md "The one-line hook, not auto-discovery"
