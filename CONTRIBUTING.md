# Contributing

## Ground rules
- **Real input only.** Actions go through `page.mouse` / `page.keyboard` / `page.touchscreen` / CDP input.
  Never `map.fire()`, never synthetic DOM events. Tests that would pass against a broken app are worthless.
- **Public MapLibre API only** in `src/inpage/maplibre-adapter.ts` and `maplibre-paint.ts`. No underscore fields.
- **`src/inpage/engine.ts` imports nothing from any map library.** Library knowledge lives behind the
  adapter seam (`src/inpage/types.ts`).
- **No network in tests.** Everything an app fetches is fulfilled by `page.route` from fixtures in the repo.
- **The flake bar.** A change is done when `npx playwright test --repeat-each=20` passes with zero
  flakes, zero retries and no fixed sleeps — on a quiet machine (check `uptime` first).
- **Do not bend third-party apps** under `wild/` to fit the library: exactly one added line (the hook)
  per app, verified by `bash wild/scripts/examples.sh verify`. If something is awkward, fix the library
  or write the friction down.
- **Licenses.** Third-party material only under MIT / BSD / ISC / Apache-2.0 / CC0 / Unlicense / OFL
  (fonts), with its license file kept and a row in `wild/fixtures/SOURCES.md` or
  `docs/THIRD_PARTY_NOTICES.md`. No OpenStreetMap-derived data (ODbL), no CC-BY assets, no vendor tiles.
- Nothing from anyone's employer: no code, names, data or screenshots.

## Working
```sh
npm i && npx playwright install chromium
node demo/scripts/copy-worker.mjs
npx playwright test            # e2e (demo app + wild apps) and unit tests
npm run typecheck
bash scripts/kill-preview.sh   # stop THIS repo's servers (never pkill by pattern on a shared machine)
```
Design decisions, dead ends and mistakes are recorded candidly in `the design notes`; read the relevant
phase before re-opening a settled question. API changes update `README.md` (API reference table)
and `CHANGELOG.md`.

## Contributions and licensing
To be completed when a license is chosen (the license options note). Expected: inbound = outbound,
with a DCO sign-off (`git commit -s`).
