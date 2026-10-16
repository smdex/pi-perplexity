# Triage labels

Apply these exact labels to local Beads tickets. Tracker operations are
defined in `docs/agents/issue-tracker.md`; no remote label setup is needed.

| Role | Label | Meaning |
| --- | --- | --- |
| Maintainer review | `needs-triage` | Needs evaluation. |
| Missing information | `needs-info` | Waiting for more information. |
| Agent implementation | `ready-for-agent` | Specified and ready for an agent. |
| Human implementation | `ready-for-human` | Requires human implementation. |
| Not planned | `wontfix` | Will not be actioned. |

Labels do not replace ticket status or dependency edges. A ticket labeled
`ready-for-agent` is available only when its blockers are resolved and it
has not been claimed.
