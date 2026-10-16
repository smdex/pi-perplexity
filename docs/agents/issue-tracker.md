# Issue tracker: local Beads

## Authority and scope

Local Beads (`bd`) is the sole tracker for specifications, tickets,
dependencies, claims, labels, and completion. The database uses embedded
Dolt under `.beads/`, with the issue prefix `pplx`.

Issues stay local. GitHub mirroring, Dolt federation, scheduled sync, and
sync hooks are disabled. No GitHub credentials or remote labels are needed.
Source-code remotes and existing user authentication remain unchanged.

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

PRs do not independently close local work. Record verification and close
the corresponding local tickets; remote publication is not a completion gate.

## Storage and revision safety

Runtime database files are ignored by Git. Tracked configuration alone is
not a ticket backup; automatic backups and exports are disabled. Obtain
user approval before introducing a backup or remote replication workflow.

`dolt.local-only: true` is enabled and no Dolt remote is configured. Local
Dolt commits are database history, not permission to push source revisions.
This installed `bd` also creates Git commits during initialization and some
tracked-config changes; inspect `jj status` afterward and keep repository
revision management in JJ. Do not reinitialize the existing database.

Engineering skills may edit `docs/agents/*.md` when conventions change;
remote issue publication or synchronization requires new user approval.
