# 0017. The Playwright peer floor is the version a CI job runs

- Status: Proposed
- Date: 2026-09-24
- Decided by: Shai Sinai (to accept or reject)
- Supersedes: 0014

## Decision
Peer ranges and support statements name only versions a CI job actually runs (0014's rule, unchanged).
The `@playwright/test` peer floor is `>=1.49.0`: the `playwright-floor` job installs exactly the version
that `peerDependencies` names and runs the typecheck and the suite with it. Lowering the floor means
changing that one field and seeing the job pass.

## Why
0014 recorded the floor as the tested 1.63 and a correction as pending. The correction was made: the
`playwright-floor` job proved 1.49.0 (1.48 lacks an API the library uses), and the published range was
lowered to it. 0014's numbers and its "not enforced by a check yet" are no longer true.

## Consequences
- easy: the floor cannot drift from what is tested — the job reads it from `package.json`
- costs: a CI job with its own browser install; Playwright < 1.52 on Node 22.18+ needs `--no-experimental-strip-types`
- enforced by: the `playwright-floor` job in `.github/workflows/ci.yml` (it fails unless `peerDependencies['@playwright/test']` is `>=X.Y.Z` and that exact version installs and passes); the compat matrix for the map libraries

## More
- 0014 (superseded), 0011
- README.md "Supported map library versions"; package.json
