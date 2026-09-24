# 0012. Reference docs live with the code; articles live on the site

- Status: Superseded by 0018
- Date: 2026-09-22
- Decided by: Shai Sinai

## Decision
Reference documentation and recipes (`README.md`, `docs/RECIPES.md`, `docs/DESIGN.md`) live in this
repository and change in the same pull request as the code they describe. Long-form articles (guides,
the case for grey-box map testing) live on geowright.dev, carry a date, and link here for reference.
Code examples in both are run as tests.

## Why
Reference docs that live apart from the code drift from it; one pull request that changes both cannot.
Articles are different: they argue and teach, they are read as of a date, and they do not have to track
every API change — but a broken example in one still costs trust, so examples are tested either way.

## Consequences
- An API change is not done until the README API table and the affected recipes are updated with it.
- The site links to reference pages here instead of copying them; any claim the site makes about
  behaviour points at a doc or test in this repository.
- Enforced by review today; running the examples as tests is a roadmap item.

## More
- [ROADMAP.md](../../ROADMAP.md) — "Docs you can trust"; [0001](0001-how-work-is-decided-and-tracked.md)
