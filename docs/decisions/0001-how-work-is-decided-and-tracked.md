# 0001. State lives in the tracker, decisions in records, rules in checks

- Status: Accepted
- Date: 2026-09-22
- Decided by: Shai Sinai

## Decision
Project state (what is in progress, what is blocked, what needs the maintainer) lives in GitHub issues,
pull requests and CI — never in a status file. Decisions live in `docs/decisions/`, one short record each.
Rules live in checks where they can, and in `CONTRIBUTING.md` / `AGENTS.md` where they cannot.

## Why
Most of the work on geowright is done by AI agents in sessions the maintainer reviews. A hand-written
status file is wrong the moment it is committed, and an append-only log grows faster than anyone reads
it. What stays true is what is enforced (a failing test cannot silently go stale) and what was decided on
purpose. Instructions for driving a particular AI tool change with every model release, so they do not
belong in the repository at all.

## Consequences
- A new session starts from an issue plus `AGENTS.md`; there is no required reading list.
- A session ends with a report on the issue or PR, not an update to a file.
- A question for the maintainer is an issue labelled `owner-decision`; an answer that changes direction
  becomes a record.
- Not enforced by a check; `AGENTS.md` tells agents not to create status files.

## More
- [AGENTS.md](../../AGENTS.md), [CONTRIBUTING.md](../../CONTRIBUTING.md), [ROADMAP.md](../../ROADMAP.md)
