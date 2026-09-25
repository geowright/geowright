# 0009. Deterministic tests: no network, no flakes, no fixed sleeps

- Status: Superseded by 0021
- Date: 2026-09-20
- Decided by: Shai Sinai

## Decision
Tests use no network: everything an app under test fetches is answered by `page.route` fixtures,
and a non-local request fails the test. A change is done only when
`npx playwright test --repeat-each=20` passes with zero flakes, zero retries, and no fixed sleeps,
on a machine confirmed quiet. A test is never deleted or loosened to reach that bar without
writing down why.

## Why
Network calls are the single biggest source of nondeterminism in a UI test, on top of the timing
hazards a canvas/WebGL map already has (frame-boundary events, animation settling). A fixed sleep
found early in the project turned out to guard against a race that had a real fix, not a timing
problem — so fixed sleeps are treated as a symptom, not a solution. The write-down-why rule exists
so the flake bar is never met by quietly weakening the suite instead of fixing the real cause.

## Consequences
- easy: a green run is trustworthy evidence, not a coin flip; failures reproduce because there is no network jitter to blame
- costs: every fixture (tiles, glyphs, vector tiles) has to be built and committed rather than fetched live
- enforced by: the map test fixture aborts and fails any non-local request; CONTRIBUTING.md "Ground rules"

## More
- CONTRIBUTING.md
- docs/RECIPES.md
- tests/
