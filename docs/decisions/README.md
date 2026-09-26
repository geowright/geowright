# Decision records

One file per decision: `NNNN-short-title.md`, numbered in order. The directory listing is the index —
there is no separate list to keep up to date.

- **Accepted** records are not edited (typos aside). To change a decision, write a new record that says
  `Supersedes NNNN`, and change the old one's status line to `Superseded by NNNN` — the only edit it gets.
  One exception: an Accepted record may be amended only to replace a reference its readers cannot follow; the
  decision never changes, and the record says so in an `Amended YYYY-MM-DD: …` line under its status.
- **Proposed** records are waiting for the maintainer. They are linked from an issue labelled
  `owner-decision`; the record is accepted or rejected there.
- Keep each record short (about 12–30 lines). The long reasoning, with evidence, belongs in
  `docs/DESIGN.md`; link to the section.

## Template

```markdown
# NNNN. <The decision, as a short statement>

- Status: Proposed | Accepted | Superseded by NNNN
- Date: YYYY-MM-DD
- Decided by: <name>

## Decision
<One to three sentences, phrased as a rule someone can follow.>

## Why
<The forces, and what this rules out.>

## Consequences
- <What it makes easy, what it costs.>
- <How it is enforced: the test, CI step or review rule — or "not enforced by a check".>

## More
- <Links: other records, docs/DESIGN.md sections, code.>
```
