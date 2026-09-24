# Contributing

## Before you start
- **Open an issue first** for anything bigger than a fix to an obvious bug, and wait for a go-ahead: the
  maintainer works on this in limited time, and a pull request nobody asked for may be closed unreviewed.
  An app that geowright does not work on is always welcome — use the "app does not work" issue template. The path
  from there to a vendored app in the test suite and a fix is [wild/README.md, "Bring your app"](wild/README.md#bring-your-app).
- Direction is in [ROADMAP.md](ROADMAP.md); settled questions are in [docs/decisions/](docs/decisions/).
  To argue with a decision, bring new evidence in an issue — not a pull request that quietly undoes it.
- **AI-assisted contributions are welcome, under the same bar.** You are the author: you have read every
  line, you can explain it, and the evidence (a test that failed before your change and passes after it)
  is in the pull request. [AGENTS.md](AGENTS.md) gives your agent the rules and the traps; point it there.

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
npm run pack:local             # a .tgz for trying the package in another project
GEOWRIGHT_CPU_THROTTLE=4 npx playwright test --workers=3   # the suite on a 4x slower CPU: for measuring, not a verdict
```
Design decisions, dead ends and the evidence behind them are recorded in `docs/DESIGN.md`; read the
relevant section before re-opening a settled question. API changes update `README.md` (API reference table)
and `CHANGELOG.md`.

## Contributions and licensing
geowright is licensed under [Apache-2.0](LICENSE). Contributions are accepted under the same terms
(**inbound = outbound**, Apache-2.0 §5): by submitting a change you license it to the project and its
users under Apache-2.0, including the patent grant in §3. There is **no CLA**.

Every commit must carry a **Developer Certificate of Origin** sign-off — `git commit -s`, which adds

```
Signed-off-by: Your Name <you@example.com>
```

By signing off you certify the [DCO 1.1](https://developercertificate.org/): that you wrote the change or
otherwise have the right to submit it under the project's license. Use a real name (a GitHub `noreply`
address is fine). Commits without a sign-off are not merged.

- Do not add SPDX or license headers to files under `wild/` — they are other people's files, kept as
  upstream wrote them, under their own licenses.
- New files of ours need no header; the repository-level `LICENSE` covers them.
- If a change makes esbuild bundle a new package into the injected scripts, `npm run build` lists it in
  `dist/THIRD_PARTY_LICENSES.txt` by itself; add its attribution to `NOTICE` and a row to
  `docs/THIRD_PARTY_NOTICES.md`.
