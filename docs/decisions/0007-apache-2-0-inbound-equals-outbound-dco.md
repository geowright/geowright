# 0007. Apache-2.0, inbound = outbound, DCO sign-off, no CLA

- Status: Accepted
- Date: 2026-09-20
- Decided by: Shai Sinai

## Decision
geowright is licensed Apache-2.0. Contributions are accepted under the same terms —
inbound equals outbound, Apache-2.0 §5 — and every commit needs a Developer Certificate of
Origin sign-off (`git commit -s`). There is no contributor license agreement.

## Why
Apache-2.0's explicit patent grant matters for the techniques this library relies on, and it is
the same license the project it extends uses, which removes one thing from a user's legal review.
A CLA was considered and rejected: a CLA only matters if relicensing later needs to stay possible,
and that option cannot be added after outside contributions already exist, so it had to be decided
up front rather than deferred. DCO sign-off was chosen instead to keep contributor friction low.

## Consequences
- easy: installable in corporate CI without a legal review; contributors sign off with one flag, no separate agreement to sign
- costs: relicensing the core to something more restrictive later is effectively foreclosed once outside contributions exist, since that would need every contributor's consent
- enforced by: CONTRIBUTING.md; commits without a `Signed-off-by` are not merged, checked by review rather than an automated DCO bot in this repository

## More
- README.md "License"
- CONTRIBUTING.md "Contributions and licensing"
