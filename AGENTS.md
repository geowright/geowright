# AGENTS.md

Instructions for AI coding agents (and the humans driving them) working on geowright. Humans: this is
also the shortest accurate map of the repository.

**Before changing code, read [CONTRIBUTING.md](CONTRIBUTING.md) § Ground rules.** They are the project's
invariants (real input only, public map-library API only, no network in tests, the flake bar, licenses).
They are not repeated here, so there is one copy to keep true.

## How work is organised
- **State lives in the issue tracker, CI and git — never in a file.** Do not create status, handoff,
  progress or notes files. If you need to leave something for the next session, it goes in the issue.
- **Start from an issue.** Read it, the decision records it links, and the `docs/DESIGN.md` section for the
  area you touch. Nothing else is required reading.
- **Decisions are in [`docs/decisions/`](docs/decisions/)** — short, numbered, never edited after they are
  accepted. Do not re-open an accepted decision in code or in conversation; if new evidence says it is
  wrong, draft a new record that supersedes it (status `Proposed`) and say so in the issue.
- **Questions only the maintainer can answer** (API shape, scope, licensing, anything outward-facing): ask
  in the issue and label it `owner-decision`. Keep working on whatever the question does not block.
- **Direction** is in [ROADMAP.md](ROADMAP.md). Work that is not on it needs an issue that says why.

## What "done" means
1. A behaviour change comes with a test that failed before it and passes after it.
2. `npx playwright test` and `npm run typecheck` pass. A change to waiting, input or timing also passes
   `npx playwright test <spec> --repeat-each=20` with zero flakes and zero retries.
3. A public API change updates the README API table and `CHANGELOG.md` (Unreleased) in the same change.
4. The report — PR description or issue comment — says: what changed; the evidence (commands run and their
   results); **mistakes and dead ends first**, in plain words; what is left; decisions needed.
5. A new rule you had to learn the hard way becomes a check (a test, a lint, a CI step) if it can be one,
   and a line in this file if it cannot.

## Map
| Path | What |
|---|---|
| `src/inpage/types.ts` | The adapter seam: what the engine may ask a map library (published typings) |
| `src/inpage/types-internal.ts` | Seam additions that are internal until 1.0; never imported by the published typings |
| `src/inpage/engine.ts` | Queries, identity, visibility, actionability. Imports nothing from any map library |
| `src/inpage/maplibre-adapter.ts`, `maplibre-paint.ts` | The MapLibre / Mapbox GL v1 adapter; style evaluation via `@maplibre/maplibre-gl-style-spec` |
| `src/inpage/index.ts`, `agent-entry.ts` | What is injected into the page (`window.__geowright`) |
| `src/playwright/` | The Playwright binding: `map()`, locators, matchers, actions |
| `src/cli/` | `npx geowright init` |
| `agent/` | Using geowright from AI agents through Playwright MCP (`MAP_SKILL.md`) |
| `demo/` | The first-party demo app the core specs run against |
| `wild/` | Real-world apps and MapLibre examples, vendored with their licenses (see `wild/README.md`) |
| `tests/` | Core specs; `tests/wild/` runs the wild apps; `tests/compat/` the version matrix |
| `docs/DESIGN.md` | Why the design is what it is, with the evidence. `docs/RECIPES.md`: how-tos |

## Commands
```sh
npm ci && npx playwright install chromium && node demo/scripts/copy-worker.mjs   # first time
npx playwright test                          # everything (demo + wild apps + unit)
npx playwright test tests/act.spec.ts        # one spec
npm run test:compat                          # the MapLibre 2–6 / Mapbox GL 1.13 matrix
npm run typecheck
npm run build                                # dist/: in-page bundle, node entry points, types
bash scripts/kill-preview.sh                 # stop THIS repo's preview servers (never pkill by pattern)
```

## Traps already paid for
- **Read the installed version, not your memory.** Check `package.json` and the typings in `node_modules`
  before relying on an API: map libraries, Playwright, Vite and TypeScript here are recent majors.
- Specs run against the **built** demo (`vite preview` on :4173, reused if already running). After changing
  `demo/`, stop it with `bash scripts/kill-preview.sh` or you test stale code. `wild/serve.mjs` serves :4174.
- Wrapper apps under `wild/apps/*` are **prebuilt and committed** (`dist/`); rebuild inside the app with
  `npm ci && npm run build`. Wild apps get exactly one added line; `bash wild/scripts/examples.sh verify`.
- Two Playwright runs at once wipe each other's `test-results/` (fake `ENOENT … trace` failures). Give every
  concurrent run its own `--output=test-results/<name>`.
- Queries match **visible** features by default. Feature identity is id + properties; id-less look-alikes
  are split by on-screen contact.
- On a globe, MapLibre's viewport queries are wrong; the adapter works around it. Do not "simplify" that.
- Every pixel probe makes MapLibre reload the layer's source — probes are not free.
- `.not` on a retrying matcher needs its own notion of "settled", or it passes before the map has drawn.
- Software GL on hosted Linux CI is several times slower than a laptop: budget timeouts from measurements
  (`GEOWRIGHT_CPU_THROTTLE=4` simulates it), never from a fixed sleep.
- Run the full suite before committing anything that changes an output format (messages, snapshots).
