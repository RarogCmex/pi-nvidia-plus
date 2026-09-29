# Issue tracker: local Markdown

Issues and specs for this repo live as markdown files in `.scratch/` — a local,
gitignored working directory that is deliberately **not published**. The notes
carry maintainer-side operational detail (test endpoints, where credentials are
kept, per-ticket process state) that does not belong in a public repository.
Design evidence worth publishing lives in [`research/`](../../research/) instead.

## What this means for a reader of the source

Comments in `extensions/` and `test/` cite those work items by number —
`тикет 15`, `Story 23`, `исследование 03`. **The numbers are not resolvable from
this repository.** They are provenance markers: each one says "this line exists
because of a specific piece of investigated work", and the sentence around it
always carries the actual reason. `исследование NN` / `research NN` *is*
resolvable — those are the published files in [`research/`](../../research/).

If a comment seems to rest on the number alone, that is a bug in the comment;
please open an issue rather than guessing.

## Conventions (maintainer-side)

- One feature per directory: `.scratch/<feature-slug>/`
- The spec is `.scratch/<feature-slug>/spec.md`
- Implementation issues are one file per ticket at
  `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`
- Triage state is a `Status:` line near the top of each issue file
  (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`)
- Comments and conversation history append to the bottom under `## Comments`
