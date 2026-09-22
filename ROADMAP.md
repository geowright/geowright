# Roadmap

**Where this is going:** when someone asks "how do I test a MapLibre map in Playwright?", the answer is
geowright — because it is correct, it explains its failures, and it is where MapLibre users already look.

Stages are in order, not on dates. The maintainer orders the work; an item moves when an issue or a
[decision record](docs/decisions/) moves it. Each stage has an exit: what has to be true to call it done.

## Now — 0.x: known in the MapLibre world
- Docs you can trust: every code example in `README.md` and `docs/RECIPES.md` is run by the test suite.
- A long-form guide on geowright.dev: testing canvas maps — why pixel coordinates, screenshot diffs and
  `map.fire()` each fail, and what to do instead.
- Listed where MapLibre users look for tools (the MapLibre ecosystem lists and docs).
- "Bring your app": a clear path for users to submit an app that does not work, which becomes a vendored
  wild app and a fix.
- Failures that explain invisibility: when a feature is painted invisibly, say which style property and
  which expression branch made it so, at which zoom.

**Exit:** the guide is published, geowright is listed in the MapLibre ecosystem, and apps from people
outside the project run in the wild suite.

## Next — 1.0: the contract
What other people's code depends on is frozen, most expensive first:
1. The app hook — `(window.__geowright_maps ??= {}).<name> = map` — which lives in users' application code.
2. The in-page API (`window.__geowright`), which the agent layer and any future language binding call.
3. The TypeScript API, under semver: deprecate in a minor release, remove only in the next major.

**Exit:** the three contracts are documented as stable, the supported-version matrix is published and
tested in CI, and a deprecation policy is in `CONTRIBUTING.md`.

## Later — reach
- A Python binding (pytest plugin) that drives the same in-page bundle — a binding, not a port.
- Mapbox GL JS v2+ adapter, after its terms are checked for testing tools.
- Touch gestures and drawing tools under touch.
- Globe and terrain in the version matrix.

## Not planned
- Anything a test verdict depends on behind a paywall ([0013](docs/decisions/0013-the-open-source-line.md)).
- Our own evaluator of MapLibre style expressions: we use MapLibre's.
- Reading a map library's private internals: public API only.
- Pixel-diff screenshots as the primary assertion.
