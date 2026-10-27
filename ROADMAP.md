# Roadmap

**Where this is going:** when someone asks "how do I test a MapLibre map in Playwright?", the answer is
geowright — because it is correct, it explains its failures, and it is where MapLibre users already look.
Further out, when someone asks the same about another map library or another test runner, the answer should
still be geowright, using the same engine.

Stages are in order, not on dates. The maintainer orders the work; an item moves when an issue or a
[decision record](docs/decisions/) moves it. Each stage has an exit: what has to be true to call it done.
"Exploring" means the questions are open: nothing in it is promised.

## Now — 0.1.x: keep it steady
Patch releases. No new API.
- The `animate-point` flake: root cause found and fixed, not retried away
  ([0021](docs/decisions/0021-deterministic-tests-guard-on-every-page.md)).
- License files that ship with each published file set
  ([0020](docs/decisions/0020-third-party-allowlist-adds-0bsd-and-unicode-data.md)).
- Dependency hygiene: the `@maplibre/geojson-vt` range moves with what CI runs; Playwright 1.64.x is held back
  until the suite passes on it ([0017](docs/decisions/0017-the-playwright-floor-is-the-one-ci-runs.md)).

**Exit:** 0.1.2 is on npm, and the 20x flake bar passes on its commit
([0025](docs/decisions/0025-hosted-manual-flake-run.md)).

## Next — 0.2: known in the MapLibre world
In this order:
1. A long-form guide on geowright.dev: testing canvas maps — why pixel coordinates, screenshot diffs and
   `map.fire()` each fail, and what to do instead.
2. Listed where MapLibre users look for tools (the MapLibre ecosystem lists and docs).
3. Apps from people outside the project, running in the wild suite
   ([wild/README.md](wild/README.md#bring-your-app)).
4. Getting ready for the contract: a design note on what the in-page API (`window.__geowright`) freezes at 1.0,
   written before the TypeScript API is frozen, because the in-page API is the one other code calls. It answers
   one question the later stages depend on: whether the in-page API stays a set of queries, or also describes the
   steps of an action, so that a binding for another test runner or language stays thin.

Already done in 0.x: docs you can trust (every example in `README.md` and `docs/RECIPES.md` runs as a test);
"bring your app"; failures that explain invisibility.

**Exit:** the guide is published, geowright is listed in the MapLibre ecosystem, apps from people outside the
project run in the wild suite, and the in-page API design note is accepted or rejected.

## Then — 1.0: the contract
What other people's code depends on is frozen, most expensive first:
1. The app hook — `(window.__geowright_maps ??= {}).<name> = map` — which lives in users' application code.
   Already frozen from 0.1.0 ([0002](docs/decisions/0002-the-app-hook-contract.md)); 1.0 documents it as stable.
2. The in-page API (`window.__geowright`), which the agent layer and any future binding call.
3. The TypeScript API, under semver: deprecate in a minor release, remove only in the next major.

**Exit:** the three contracts are documented as stable, the supported-version matrix is published and
tested in CI, and a deprecation policy is in `CONTRIBUTING.md`.

## Reach — the engine
After 1.0. Geowright is already split in two: an engine that runs inside the page and knows how maps work
(finding features, visibility, geometry, aiming, the check at the moment of a press, diagnostics), and a
Playwright binding that sends real input and waits. The engine imports nothing from a map library or a test
runner. Reach makes that split a public shape: the engine, a map-library seam behind it, and one thin package per
test runner in front of it.

Each item below is its own small stage, with its own exit, taken one at a time.
- **A second map library.** OpenLayers first: its hit test, its render-complete signal and its overlays are all
  public. The seam ([0004](docs/decisions/0004-the-adapter-seam.md)) gets one new, library-neutral member.
  *Exit:* an OpenLayers adapter passes the same core specs as MapLibre, with no engine change beyond that member,
  and a record supersedes [0011](docs/decisions/0011-supported-map-libraries.md).
- **A runner-neutral core.** The Playwright binding is split into a core that knows nothing about Playwright and
  a driver interface with one implementation: Playwright. The 0.x and 1.0 Playwright API does not change.
  A conformance suite describes what every driver must pass.
  *Exit:* the Playwright package passes the full suite and the conformance suite through the driver interface.
- **Puppeteer.** The second driver, because it costs least: the same browser protocol Playwright uses for touch.
  *Exit:* the conformance suite passes on Puppeteer, including the 20x flake bar.
- **WebDriver BiDi** (WebdriverIO and Selenium for JavaScript). Brings Firefox, and multi-touch that is not tied
  to Chromium. *Exit:* the conformance suite passes on Chrome and Firefox through BiDi.
- **A Python binding** (a pytest plugin) that drives the same in-page engine — a binding, not a port.
- **Mapbox GL JS v2+**, after its terms are checked for testing tools.
- **Drawing tools under touch** (the draw helpers use the mouse today).
- **Globe and terrain** in the version matrix.
- **Cypress, only if people ask for it.** Its commands are queued rather than awaited, and its default clicks are
  synthetic events; a Cypress package would send real input through the browser protocol (Chromium only) and
  express every wait as a Cypress query. It is the most expensive driver to build and to keep.

**Exit for Reach as a whole:** none. Each item stands on its own exit, and a driver or library that no CI job
runs is not claimed as supported.

## Exploring — mobile
Questions, not promises. Three different problems:
- **Maps in a mobile browser.** Playwright's device emulation already runs geowright with touch on desktop
  Chromium. Next to explore: Chrome on a real Android device, which Playwright drives through the same protocol
  (its Android support is experimental), and Safari on iOS, which needs Appium and a different input path.
- **Apps that show a web map in a WebView** (Capacitor, Ionic, React Native WebView). The engine runs there as it
  is: the open question is how a test reaches into the WebView and sends real touches to it.
- **Apps with a native map SDK** (MapLibre Native, the Mapbox Maps SDK, Google Maps). There is no page to run the
  engine in. It would take a test-only hook on the native side and a different bridge; MapLibre Native is the
  closest fit: its public API has the same hit test as MapLibre GL JS. Research only.

## Not planned
- Anything a test verdict depends on behind a paywall ([0013](docs/decisions/0013-the-open-source-line.md)).
- Our own evaluator of MapLibre style expressions: we use MapLibre's.
- Reading a map library's private internals: public API only.
- Pixel-diff screenshots as the primary assertion.
- Driving a map with synthetic events, in any runner: real input only
  ([0003](docs/decisions/0003-real-input-only.md)).
- Adapters for Google Maps or ArcGIS: proprietary, and they need the network.
