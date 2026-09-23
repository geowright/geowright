# 0013. The open-source line: nothing a verdict depends on is paid

- Status: Accepted
- Date: 2026-09-20
- Decided by: Shai Sinai

## Decision
Nothing a test verdict depends on will ever be paid. Everything that decides whether a test
passes or fails — the adapter, the engine, actionability, matchers, the snapshot and
accessibility mirror, diagnostics, and failure artifacts — is open source under Apache-2.0 and
stays that way.

## Why
A testing library that is deliberately incomplete is not trusted, and an untrusted testing
library does not get installed in CI, so crippling the core to build a paid tier would undermine
the only real asset a testing tool has. This is the same line a free test runner and its paid
hosted service usually draw, and it rules out ever moving a verdict-relevant check behind a
paywall later, however convenient that might seem.

## Consequences
- easy: anyone can audit exactly why a test passed or failed without a support contract; adoption in CI does not require a purchasing decision first
- costs: forecloses the easiest monetization lever — any future paid offering has to be about what happens after a run, never during it
- enforced by: README.md "Open source, and staying that way" as a public commitment; not enforced by an automated check, only by review keeping new features off the paid side of the line

## More
- README.md "Open source, and staying that way"
- docs/DESIGN.md
