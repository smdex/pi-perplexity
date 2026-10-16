# Issue tracker: local Beads, push-only GitHub mirror

## Authority and scope

Local Beads (`bd`) is authoritative for specifications, tickets, dependencies,
claims, labels, and completion. The initialized database uses embedded Dolt
under `.beads/`, with the issue prefix `pplx`. Runtime database files are
ignored by Git; the tracked configuration alone is not a ticket backup.

GitHub Issues in `smdex/pi-perplexity` is a manually updated, push-only mirror.
Read and edit tickets locally, not on GitHub. Never pull GitHub edits into
Beads or run bare `bd github sync`, whose default is bidirectional.

**PRs as a request surface: no.** A PR does not independently close local
work; record verification and close the corresponding local tickets.

## Ticket operations

```bash
bd create "Ticket title" --type task --description "Spec: docs/pplx-cli-spec.md"
bd list --json
bd show <id> --json
bd ready --json
bd update <id> --claim
bd dep add <blocked-id> <blocker-id>
bd comments add <id> "Result, verification, and revision/context pointers"
bd close <id> --reason "Implemented and verified; revision/context pointer"
```

When a skill says to publish to the tracker, create a local Bead. When it
says to fetch a ticket, use `bd show`. Represent prerequisites with native
blocking dependencies, not only prose or checklist order. Use `bd ready`
and the feature's ticket grouping to find the frontier, then claim work
atomically. Close only after acceptance criteria are verified; unresolved
blockers remain authoritative. Use `docs/agents/triage-labels.md` for labels.

## Manual mirror workflow

The local database has `github.repository = smdex/pi-perplexity`. Supply
`GITHUB_TOKEN` through the invoking environment when mirroring; never put
a token in tracked files or command arguments. It needs GitHub Issues write
access for this repository. `gh` authentication is not automatically used
by this installed Beads GitHub integration.

Preview selected tickets, review their contents for secrets/private data,
then push the same selection:

```bash
bd github push <id> [<id>...] --dry-run
bd github push <id> [<id>...]
```

These commands are equivalent to `bd github sync --push-only --issues ...`.
Use an explicit selection to avoid publishing unrelated local work. Sync
only when requested; no scheduled jobs or automatic hooks are configured.
Do not use `bd sync` or Dolt push/pull for this mirror: those replicate the
Dolt database, not GitHub Issues. `dolt.local-only: true` is enabled and no
Dolt remote is configured. Local Dolt commits are database history, not
permission to push source revisions. This installed `bd` also creates Git
commits during initialization and some tracked-config changes; inspect
`jj status` afterward and keep repository revision management in JJ.

## Setup verification and current limitations

- Local database initialization, repository selection, and an empty ready
  query succeeded. No specification tickets have been created yet.
- Mirror dry-run is blocked until `GITHUB_TOKEN` is supplied. No issues have
  been pushed, pulled, or published by setup.
- The current `gh` account reports `READ` permission. Creating the four
  missing triage labels returned HTTP 404. `wontfix` already exists; create
  the remaining names from `triage-labels.md` with a write-capable account
  before the first mirror push. Do not change global accounts automatically.
- Dependency/label fidelity and repeat-push deduplication remain unverified
  against GitHub. Keep Beads authoritative even if the mirror omits metadata.

Engineering skills may edit `docs/agents/*.md` when conventions change;
changing tracker authority or sync direction requires user approval.
