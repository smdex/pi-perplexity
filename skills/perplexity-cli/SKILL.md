---
name: perplexity-cli
description: |
  Search and ask Perplexity from the command line via the `pplx` CLI, using a
  Perplexity Pro/Max subscription session (cookie auth, no API key). Use this
  skill whenever the user wants to ask Perplexity, do a web-backed Q&A with
  citations, continue a previous Perplexity thread, run deep research, list
  or manage their Perplexity chats/threads or spaces (rename, pin, delete,
  create), check available models or connectors, or attach files to a
  Perplexity query. Triggers on "ask Perplexity", "search Perplexity", "pplx",
  "perplexity cli", "deep research via Perplexity", "continue my Perplexity
  thread", "list my Perplexity spaces". Do NOT trigger for generic web
  search, fetching a known URL, or local file operations — this skill is
  specifically about the Perplexity service through the pplx CLI.
compatibility: "Requires the pplx CLI (NixOS: `nix profile install -f .` from the pi-perplexity repo; elsewhere: the pi-perplexity checkout root, run via `bun run src/index.ts` or installed as `pplx`), plus a one-time `pplx login` or a `PPLX_COOKIE` env var."
---

# Perplexity CLI (`pplx`)

Ask Perplexity from scripts and agents. Interactive TTY stdout gets a live
alternate-screen preview with revisions redrawn; non-TTY/redirected stdout
receives the complete answer once at the end, followed by citations and
follow-ups. `--no-stream` disables preview. Auth is a logged-in browser
session (cookies) — no API key, subscription-only.

## Pre-flight (every session)

```bash
command -v pplx >/dev/null || echo "NO_PPLX"    # find the binary
pplx login --status | head -20                  # check the stored session
```

If `pplx` is missing, ask the user how to install it (NixOS:
`nix profile install -f .` from the pi-perplexity repo; dev checkout:
`bun run <repo>/src/index.ts …`). Never install it silently.

If not logged in, exit code is `2`. Stop and ask the user to run `pplx login`
(interactive email OTP; needs the user to read their email). `PPLX_COOKIE`
bypasses login for one invocation — ask the user for the header value, never
fabricate one. Do not edit files under `~/.config/pplx-cli/`.

## Core patterns

```bash
# One-shot question, markdown out (inherits CLI settings; built-in model: gemini38flash)
pplx ask "question"

# Structured result for reliable parsing (single JSON object on stdout)
pplx ask --json "question"

# Dump the reply to a file (full markdown: answer + sources/meta; raw JSON with --json)
pplx ask --save reply.md "question"

# Choose model / restrict sources / attach files / target a space
pplx ask --model <slug> "question"              # slugs: pplx models (any slug passes through)
pplx ask --sources web scholar "question"       # ids: pplx connectors --all
pplx ask --attach report.pdf "question"         # uploads, then asks about it
pplx ask --space "Money Manager" --no-incognito "question"     # uuid works too; thread is created in the space

# Image generation (image-mode models, e.g. nanobanana2) — output carries a
# ## Images section: S3 url, caption, dims, suggested filename. Urls are
# presigned and expire ~35min; --save-images downloads them immediately.
pplx ask --model nanobanana2 "generate a logo for a note-taking app"
pplx ask --model nanobanana2 --save-images ./img "same logo but minimal" # auto-download

# Deep research — multi-step pplx_alpha engine, takes minutes; use --json or a generous timeout
pplx research --json "broad multi-faceted question"

# Multi-turn — continue the thread printed by a previous ask (bare slug or full URL)
pplx ask --thread <slug> "follow-up question"

# Temp chats (default): incognito, disposable, deleted by Perplexity ~24h
# after creation. Continue the most recent live one without a slug:
pplx ask --continue "follow-up in the same chat"
pplx temp list                                 # live temp chats + TTL countdown
pplx temp cleanup                              # purge expired local state

# History
pplx chats list                                 # UPDATED MODEL TITLE UUID
pplx chats show <uuid|slug|title-prefix>        # full recorded markdown

# Thread management (<ref> = URL, slug uuid, context_uuid, or unique title prefix)
pplx chats rename <ref> "new title"
pplx chats pin <ref>                            # also: pplx chats unpin <ref>
pplx chats delete <ref>                         # typed confirmation (see Destructive ops)

# Spaces (full CRUD — live-captured contracts)
pplx spaces list
pplx spaces threads "Space title"               # or uuid — threads inside a space
pplx spaces create "Recipes" --emoji 1f37d --instructions "metric units"
pplx spaces rename <uuid|title> "New name"
pplx spaces delete <ref>                        # typed confirmation (see Destructive ops)
```

Shared defaults live in the CLI's `config.json`, separate from auth. Use
`pplx config get` to inspect them; change them only at the user's request with
`pplx config set model <id>`, `set sources <id...>`, `set space <ref>`, or
`unset <key>`. Explicit ask/tool options override saved values. `--sources web`
replaces configured connectors; `--no-space` bypasses a configured space once.
Unavailable configured scope fails rather than falling back. Space targeting
requires `--no-incognito` (library history); the CLI will not change privacy
silently. Configured spaces apply only to new threads, with a warning on
follow-ups. Research retains its own engine, ignoring saved model settings.
Stored values are shape-validated on write without network checks and
resolved/validated when used; unresolvable defaults fail closed at ask time.

Model/slug behavior: any string passes through `--model`; `pplx models` lists
the live catalog from `/rest/models/config` (default: search-mode slugs,
`--picker` for only the models the webapp UI offers, `--all` for every mode
incl. computer/asi and browser agents; `--mode <m>` filters). The endpoint has
no availability/deprecation field — retired models simply vanish from the
list. The list is cached for 24h and falls back to bundled slugs when
offline. Threads are incognito ("temp") by default: kept out of
the library and auto-deleted ~24h after the first message. While one lives,
continuation state is cached locally so `--continue` / `--thread <slug>` work
across invocations; expired entries are swept async on every launch. Use
`--no-incognito` to keep a thread in the library.

## Output contract (stdout vs stderr)

- `pplx ask` previews revisions in an alternate screen only on interactive
  TTY **stdout**, then restores the screen and prints the complete answer once.
  `--no-stream` disables preview. Non-TTY/redirected stdout receives the
  complete answer once at the end. Spinner/progress and the `follow up:` hint
  go to **stderr**. Piping `pplx ask … > answer.md` yields clean markdown:
  answer text, then `## Sources` numbered citations, `## Follow-ups`, and
  `## Meta` model + thread URL; some answers have no Sources section.
- With `--json`, stdout is a single object:
  `{answer, readWriteToken, backendUuid, threadUrl, followups, model, sources}`;
  failures print `{"error": "…"}` on stdout — parse stdout, not stderr.
- Exit codes: `0` ok · `1` error · `2` not logged in (run `pplx login`) ·
  `130` interrupted. Map exit code to behavior instead of parsing stderr.

## Secondary commands

```bash
pplx models                 # live model catalog — --picker for UI models, --all for every mode
pplx connectors             # connected sources; --all for the catalog
pplx connectors --all       # ids feed `ask --sources` (e.g. google_drive)
pplx completion bash        # shell completions (bash | zsh | fish)
```

## Destructive ops (confirm first)

`chats delete <ref>` and `spaces delete <ref>` delete **permanently** (a
space takes its threads with it). Both require a typed confirmation on stdin
(the exact thread slug / space title) unless `--yes` is passed. As an agent:
get explicit user confirmation first; do NOT pass `--yes` unprompted.
Renames, pin/unpin, and space creates are safe to run when the user asks.

## Deep research

`pplx research` submits the same ask request with the model preference
swapped to Perplexity's internal `pplx_alpha` deep-research engine (verified
against a live capture). Expect a multi-step run measured in **minutes** with
the answer arriving near the end; prefer `--json` and a generous timeout
(600s+). Deep research draws on a separate quota family (`agentic_research`
in `/rest/rate-limit/status`); quota-exhaustion errors come from the server
as-is and are NOT retryable within the same period — report them, don't retry.

## Environment variables

| Variable | Effect |
|---|---|
| `PPLX_CONFIG_DIR` | override `~/.config/pplx-cli/` (auth store, 0600) |
| `PPLX_CACHE_DIR` | override `~/.cache/pplx/` (caches + thread state) |
| `PPLX_COOKIE` | raw Cookie header override — beats the stored jar; works on its own (no `pplx login` needed) |
| `PPLX_EMAIL` / `PPLX_OTP` | non-interactive OTP login values |
| `PPLX_NO_SPINNER=1` | disable the stderr spinner |

## Streaming notes

- Interactive TTY preview redraws full-state revisions in an alternate screen;
  non-TTY/redirected stdout receives the complete answer once at the end.
  `--no-stream` disables preview, not completion validation.
- Completion is protocol-based: `COMPLETED` plus a final marker is required,
  not just EOF. Cancellation exits `130`, restores any preview, and never
  prints a partial answer as success.
- Rate limits or Cloudflare challenges surface as typed HTTP error messages.
  `401` clears the stored session and asks to re-login; `403` keeps it.
- `--attach` uploads the file first (presign → S3 POST), then asks; the
  spinner line mentions the upload phase.

## Behavior boundaries

- The underlying API is reverse-engineered (subscription web session); it can
  break without notice. Expect typed error messages, never stack traces.
- Thread and space CRUD follow live-captured contracts (t-summary.md /
  s-summary.md); rename/pin/unpin need the thread's server-side context_uuid
  (unavailable for local-only incognito threads — the CLI says so with a
  readable error).
- Incognito threads (the default) never reach server history — `chats show`
  renders them from locally recorded state under `$PPLX_CACHE_DIR/threads/`.
- `--attach` uploads to Perplexity: confirm with the user before uploading
  sensitive files.
