# 0026. A runner-neutral core between map-library adapters and thin driver adapters

- Status: Proposed
- Date: 2026-10-25
- Decided by: Pending maintainer review

## Decision
Geowright is three layers with one-way dependencies: map-library adapters behind the seam (0004); a core that owns
maps and verdicts and knows no test runner; and one thin driver package per runner that only runs code in the page,
sends real input and takes a picture. The Playwright API keeps working unchanged under the `geowright` package name.
No driver is claimed until its CI job passes a shared conformance suite (0017); a driver that cannot send real input
(0003) is not built. OpenLayers comes before a second runner; the runners follow in order: Puppeteer, then WebDriver
BiDi; Cypress only if users ask.

## Why
The in-page engine is already runner-neutral, and about 94 % of the Playwright binding is runner-neutral logic that
happens to hold a `Page`. Separating them is a refactor of working code, while a second map library proves the seam.
This rules out drivers built on synthetic input as a verdict source, and Google Maps and ArcGIS (proprietary, networked).

## Consequences
- easy: a new runner is a small `Driver` plus `Runner`; the core, verdicts and error text are shared.
- costs: each driver multiplies CI time (the 20x bar per driver), compat claims and releases; the version matrix stays
  on Playwright only. Splitting into packages needs the release pipeline to handle more than one.
- Mobile is exploring only (mobile web, WebView maps); native map SDKs are research only.
- enforced by: the seam rules unit spec today; later, no `page.` outside the Playwright driver file, and the
  conformance suite's trusted-input and sabotage guards on every driver.

## More
- docs/DESIGN.md "Drivers and map libraries"
- 0002 (the hook), 0003 (real input), 0004 (the seam), 0011, 0017, 0019, 0021 and 0025 (the flake bar)
