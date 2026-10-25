# 0025. Manual hosted run for the 20x flake bar

- Status: Accepted
- Date: 2026-10-24
- Decided by: Shai Sinai
- Supersedes: the quiet-machine clause of 0021

## Decision

The 20x flake bar may be demonstrated either on a quiet desktop machine or by a green manually
started hosted flake run. A failed hosted run is investigated because shared runners add noise,
but their failures remain evidence. The manual run uses GitHub-hosted runners and shards the suite.

## Why

The full 20x suite is too expensive to run on the owner's Mac. The public repository receives free
standard hosted minutes, and parallel shards make the run practical while retaining the existing
zero-flake, zero-retry bar.

## Consequences

- CONTRIBUTING.md documents both ways to meet the bar and requires investigation of hosted failures.
- The nightly 2x run remains separate from the manually started sharded 20x run.
- Enforced by the manual workflow's shard verdict and the contribution review bar.

## More
- 0021 (deterministic tests; its other rules remain in force)
- CONTRIBUTING.md, "The flake bar"
- .github/workflows/flake.yml
