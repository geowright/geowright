# 0014. Claim only what is tested

- Status: Superseded by 0017
- Date: 2026-09-22
- Decided by: Shai Sinai

## Decision
Peer ranges and support statements name only the versions CI actually runs. The
`@playwright/test` peer floor is the tested 1.63, not an older, unverified version, until a lower
floor is specifically proven by a test run.

## Why
`package.json` had been declaring a peer floor that was never actually tested — nobody had run
this project's behavior against anything older than 1.63. Claiming an untested version as
supported looks fine right up until a user on that old version files a bug that cannot be
reproduced here. This rules out lowering a stated floor, or widening any version claim, based on
a plausible guess rather than a CI run.

## Consequences
- easy: every compatibility claim traces to an actual CI job that asserts it
- costs: the peer floor previously published in `package.json` is not yet corrected to match this rule; the correction is planned, pending an isolated compatibility test to find the real lowest floor
- enforced by: not enforced by a check yet; the compatibility suite covers the tested versions, but nothing yet catches a stale peer-range claim

## More
- README.md "Supported map library versions"
- docs/DESIGN.md "Version compatibility"
- package.json
