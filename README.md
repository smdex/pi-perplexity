# pi-perplexity — `pplx` CLI and agent plugins

This repository is CLI-first: the root package is the standalone Bun + TypeScript
`pplx` CLI for Perplexity. The pi extension and the Hermes plugin live under
`plugins/` and delegate to the CLI:

- `plugins/pi` — [pi](https://github.com/badlogic/pi-mono) extension
- `plugins/hermes` — Hermes plugin (`perplexity_ask` / `perplexity_research`)
- `skills/perplexity-cli` — agent skill shipped with the CLI
- `research/` — captured wire contract and API notes for the CLI

The CLI itself: Ask questions (streaming,
cited answers), continue threads, manage spaces, inspect connectors — using
your Perplexity Pro/Max **web session** (cookie auth). No API key, no API
credits; only the subscription.

The underlying web API is reverse-engineered and can break without notice.
Every shipped surface (including thread/space CRUD and `--space` targeting)
follows a live-captured wire contract; see `research/network/`.

## Install

Requires [Bun](https://bun.sh) ≥ 1.2.

```bash
bun install
bun run src/index.ts --help
```

Optional: expose a `pplx` binary —

```bash
npm link        # or: bun link
pplx --help
```

### NixOS / Nix

From the repo root (builds a bundle with a store-pinned Bun shebang; no
ambient Bun or checkout is needed at runtime):

```bash
nix build .#pplx             # or: nix build (default package)
nix run .#pplx -- --help
nix profile install .#pplx

# Existing non-flake entry (uses your <nixpkgs>):
nix-build                   # ./result/bin/pplx
nix-env -if .
```

The locked flake exposes `pplx` and `default` for exactly three systems:
`x86_64-linux`, `aarch64-linux`, and `aarch64-darwin`, all using
`nixos-unstable`. `x86_64-darwin` is unsupported because current unstable
dropped it; see [Nix packaging](docs/nix.md) for details and checks.

The package also ships the agent skill under `share/pplx/skills/`:

```bash
ls result/share/pplx/skills/perplexity-cli/SKILL.md
```

## Login (once)

Three paths, tried in this order via flags:

```bash
# 1. paste cookies from a logged-in perplexity.ai tab — the parser accepts:
#      • a full curl command ("Copy as cURL" in any browser's devtools)
#      • a raw Cookie header (with or without the "Cookie:" prefix)
#      • a headers list (any `Name: value` lines; a User-Agent line is captured)
#      • Netscape cookies.txt exports
#      • one name=value pair per line
#   A captured User-Agent is replayed on every request (cf_clearance/__cf_bm
#   are bound to the UA they were issued for). PPLX_USER_AGENT overrides.
pplx login --paste
echo "Cookie: __Secure-next-auth.session-token=…; …" | pplx login --paste
pplx login --paste < curl.sh      # the saved "copy as cURL" output

# 2. import from a local browser profile
pplx login --browser firefox      # also: zen, librewolf, waterfox, chromium,
                                  #       chrome, brave, vivaldi, edge, opera,
                                  #       browseros
pplx login --browser zen --profile "Profile name"
pplx login --browser chromium --profile-location ~/.config/some-chromium-fork
                                  # --profile-location takes a browser data dir,
                                  # a profile dir, or the cookies database file
                                  # directly (any firefox- or chromium-family
                                  # browser). Chromium v11 app-bound cookie
                                  # values cannot be decrypted offline — the CLI
                                  # says so and suggests --paste.

# 3. email OTP (interactive; also non-interactive via flags or env)
pplx login                        # prompts for email + OTP code (OTP input is not echoed)
pplx login --email you@example.com --otp 123456
PPLX_EMAIL=you@example.com PPLX_OTP=123456 pplx login

pplx login --status               # stored credentials + live session check
pplx login --logout               # remove stored credentials
```

Cookies are stored at `~/.config/pplx-cli/auth.json` with `0600`
permissions and rotated automatically from `Set-Cookie` responses.

## Shared defaults

`pplx` stores settings separately from auth in `~/.config/pplx-cli/config.json`
(or `$PPLX_CONFIG_DIR/config.json`). Writes are atomic and use `0600` permissions.
Stored values are shape-validated on write without network checks and resolved/validated when used; unresolvable defaults fail closed at ask time.

```bash
pplx config set model glm_5_3_thinking
pplx config set sources web scholar
pplx config set space "Ops: linux"
pplx config get                 # also: get model; --json for machine-readable values
pplx config unset space
pplx ask "question" --sources web --no-space  # bypass saved connectors and space once
```

Explicit flags replace saved values, which replace built-in defaults. Source
lists replace, never append. Research always uses its own `pplx_alpha` engine,
regardless of the saved or explicit model. Model identifiers pass through as
with `--model`; settings commands do not fetch catalogs. Configured custom
connectors are checked against connected sources before an ask; unavailable
connectors/spaces or invalid settings stop the request rather than changing scope.

Space references use existing UUID, case-insensitive title, or unique-prefix
resolution. A saved space applies to new threads; `--thread`/`--continue` keep
the existing thread and warn rather than retarget it. Space targeting requires
`--no-incognito`: incognito-in-space is unverified, and the CLI never silently
opts you into library history. Use `--no-space` to keep the normal temp-chat
behavior instead. Unset defaults restore the command's built-ins.

Pi and Hermes inherit these CLI settings when tool arguments are omitted; do
not configure a second set of adapter defaults. For manual migration from
legacy Pi settings, copy the desired model/source/space values using the
commands above and run `pplx login` for cookie authentication. Old Pi settings
and JWT files are not imported, converted, removed, or overwritten.

## Examples

```bash
# ask — live terminal preview (final-only when piped); the chat is incognito
# ("temp") by default: disposable, kept out of library history, auto-deleted by
# Perplexity ~24h after creation. The CLI reports the temp chat id + TTL.
pplx ask "what changed in the Rust 2024 edition?"
pplx ask --model glm_5_3_thinking "explain CRDTs simply"
pplx ask --sources web scholar "papers on fuzzy matching performance"
pplx ask --attach report.pdf "summarize the key findings"
pplx ask "current stable kernel version" --json      # single JSON object
pplx ask "..." --copy                                 # + clipboard
pplx ask "..." --save reply.md                        # + dump the full reply (or JSON) to a file

# continue the most recent live temp chat (no slug needed)
pplx ask --continue "go deeper on the edition migrations"

# continue any thread (the slug is printed after every ask, or use the URL)
pplx ask --thread e2e23ed7-f797-4a12 "add a rollout timeline"

# keep the chat in library history instead of a 24h temp chat
pplx ask --no-incognito "something I want to find again later"

# temp chat registry: EXPIRES/UPDATED/MODEL/TITLE/SLUG of live temp chats
pplx temp list                 # live only; --all includes not-yet-swept expired
pplx temp cleanup              # purge local state for expired temp chats now

# ask inside a space (thread is created in the space)
pplx ask --space "Money Manager" --no-incognito "summarize my spending trends"

# image generation (image-mode models, e.g. nanobanana2): prints a ## Images
# section with the S3 urls + suggested filenames — urls expire in ~35min
pplx ask --model nanobanana2 "generate a logo for a mobile accounting app"
pplx ask --model nanobanana2 --save-images ./out "same logo, but green"  # auto-download

# deep research — pplx_alpha engine, multi-step run (takes minutes, not seconds)
pplx research "compare vector databases for a 100M-embedding workload"

# history
pplx chats list                  # alias: threads
pplx chats list --next <cursor>  # pagination cursor printed on stderr
pplx chats show <slug>           # full markdown: question + answer + citations
pplx chats rename <ref> "new title"
pplx chats pin <ref>             # also: chats unpin <ref>
pplx chats delete <ref>          # asks you to type the slug (or --yes)
# <ref> = thread URL, slug uuid, context_uuid, or unique title prefix

# spaces
pplx spaces list
pplx spaces threads "Money Manager"
pplx spaces create "Recipes" --emoji 1f37d --instructions "Prefer metric units"
pplx spaces rename <uuid|title> "New name"
pplx spaces delete <ref>          # asks you to type the title (or --yes)

# reference
pplx models                 # live model catalog — --picker for UI models only, --all for every mode
pplx connectors             # connected sources (--all: full catalog)
pplx completion bash        # shell script (bash | zsh | fish)
```

Ask output: interactive terminals show a revisable answer preview in an alternate
screen. On completion the original screen is restored and the final answer is
printed once. `--no-stream` disables the preview (use it for terminals without
alternate-screen support). Redirected stdout buffers until
completion; `--json` and `--save` contain only the final result, without preview
controls or stale text. Errors, interrupted requests, and truncated streams do
not produce a successful partial result.

The final answer is followed by a trailing
block with `## Sources` (numbered citations, when the model returns web
results), `## Images` (image-mode asks: S3 urls + suggested filenames + expiry
warning — the presigned urls die in ~35min, so download with `--save-images`
or copy them immediately), `## Follow-ups`, and `## Meta` (model + thread URL).
Progress goes to stderr, so stdout stays clean for piping:

```bash
pplx ask "…" > answer.md
```

### Temp (incognito) chats

Plain `pplx ask "…"` creates a **temp chat**: `is_incognito: true`, never added
to library history, deleted by Perplexity ~24h after creation. The chat id is
reported on stderr with its remaining lifetime, e.g.

```
temp chat e2e23ed7-f797-4a12 (expires in 23h; auto-deleted from history) — continue: pplx ask --continue "…" or --thread e2e23ed7-f797-4a12
```

While a temp chat lives, the CLI keeps its continuation state locally
(`$PPLX_CACHE_DIR/threads/`) so `ask --continue` (most recent) or
`ask --thread <slug>` (specific) keep working in the same thread across
invocations. Expired entries are swept asynchronously on every launch; the
TTL anchor is the first message, so follow-ups never reset the clock. Use
`--no-incognito` to create a normal persistent thread instead.

`pplx research` submits the same ask request with the model preference swapped
to Perplexity's internal `pplx_alpha` deep-research engine (verified against a
live capture) — expect a multi-step run measured in minutes, with the answer
arriving near the end. Deep research has its own quota family (`agentic_research`
in `/rest/rate-limit/status`); exhaustion surfaces as the server's error.

## Shell completion

```bash
pplx completion bash >> ~/.bashrc
mkdir -p ~/.zfunc && pplx completion zsh > ~/.zfunc/_pplx   # + fpath in ~/.zshrc
pplx completion fish > ~/.config/fish/completions/pplx.fish
```

TAB on `--model`, `--sources`, `--thread`, `--space` fetches live candidates
(spaces by name **and** uuid, connectors, recent threads) with a 10-minute
cache; the `<ref>` positional of `chats show|rename|delete|pin|unpin` and
`spaces threads|rename|delete` completes with chat titles and space names.
Everything else completes from the command tree. Degrades silently offline.

## Environment variables

| Variable | Effect |
|---|---|
| `PPLX_CONFIG_DIR` | override `~/.config/pplx-cli/` (auth and settings) |
| `PPLX_CACHE_DIR` | override `~/.cache/pplx/` (caches, thread state) |
| `PPLX_COOKIE` | raw Cookie header override — beats the stored jar; works on its own (no `pplx login` needed) |
| `PPLX_EMAIL`, `PPLX_OTP` | non-interactive OTP login |
| `PPLX_NO_SPINNER` | `1` disables the stderr spinner |
| `PPLX_USER_AGENT` | override the User-Agent (beats the UA captured at login) |

## Known unmet requirements (endpoints not captured)

The web API is reverse-engineered from captures; the following operations have
**no captured contract** and are intentionally not shipped:

- Thread archive and move-to-space (no UI entry / picker canceled during capture).
- Full-answer fetch for arbitrary threads (`chats show` renders the locally
  recorded exchange when this CLI made it, otherwise the server-side preview).

## Exit codes

`0` ok · `1` error · `2` not logged in (run `pplx login`) · `130` interrupted.
With `--json`, failures print `{"error": "…"}` on stdout.

## Development

```bash
bunx tsc --noEmit   # typecheck
bun test            # all tests, zero network (fixtures from research/network)
```

Architecture, wire protocol, and the assumption register live in
[`research/api-contract.md`](research/api-contract.md). The pi extension and
Hermes plugin have their own READMEs under `plugins/`.
