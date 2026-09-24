# 0018. Reference docs live with the code, and their examples run as tests

- Status: Proposed
- Date: 2026-09-24
- Decided by: Shai Sinai (to accept or reject)
- Supersedes: 0012

## Decision
Reference documentation and recipes (`README.md`, `docs/RECIPES.md`, `docs/DESIGN.md`) live in this
repository and change in the same pull request as the code they describe. Long-form articles live on
geowright.dev, carry a date, and link here for reference. Code examples in both are run as tests
(0012's decision, unchanged).

## Why
0012 listed running the examples as tests as a roadmap item. It is done: every ts/js block of README.md
and docs/RECIPES.md is type-checked and run against the demo by the normal suite, and a failure names
the file and line. 0012's "enforced by review today" is no longer true.

## Consequences
- An API change is not done until the README API table and the affected recipes are updated with it.
- A block that cannot run carries `<!-- example: skip (reason) -->`, so every exception is visible.
- enforced by: `tests/docs/` (README.md and docs/RECIPES.md code blocks, run by `npx playwright test`); review for the site's articles

## More
- 0012 (superseded), 0001, 0014 / 0017
- ROADMAP.md "Docs you can trust"
