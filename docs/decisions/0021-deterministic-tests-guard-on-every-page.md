# 0021. Deterministic tests: no network, no flakes, no fixed sleeps (the guard covers every page)

- Status: Accepted
- Date: 2026-09-25
- Decided by: Shai Sinai
- Supersedes: 0009

## Decision
Tests use no network: everything an app under test fetches is answered by `page.route` fixtures,
and any request to anywhere but the exact origin of the suite's own server fails the test, naming
the URL. A change is done only when `npx playwright test --repeat-each=20` passes with zero flakes,
zero retries, and no fixed sleeps, on a machine confirmed quiet. A test is never deleted or loosened
to reach that bar without writing down why.

## Why
The decision is 0009's, unchanged. 0009 said the guard lives in "the map test fixture". It has since
moved to the `page` fixture and the browser context, so a spec that never asks for `map`, and a
popup the page opens, are guarded too. The version matrix used its own copy, which matched the
origin as a string prefix (`:41750` passed as `:4175`); it now uses the same guard.

## Consequences
- easy: a green run is trustworthy evidence, not a coin flip; failures reproduce because there is no network jitter to blame
- costs: every fixture (tiles, glyphs, vector tiles) has to be built and committed rather than fetched live
- enforced by: `guardNetwork` in `tests/fixtures.ts` (the `page` fixture, and the compat matrix's `map` fixture), tested by
  `tests/network-guard.spec.ts`; CONTRIBUTING.md "Ground rules"

## More
- 0009 (superseded)
- CONTRIBUTING.md, docs/RECIPES.md, tests/
