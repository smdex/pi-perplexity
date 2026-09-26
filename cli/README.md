# pplx — Perplexity CLI

Standalone Bun + TypeScript CLI for Perplexity. Ask questions (streaming,
cited answers), continue threads, manage spaces, inspect connectors — using
your Perplexity Pro/Max **web session** (cookie auth). No API key, no API
credits; only the subscription.

The underlying web API is reverse-engineered and can break without notice.
Every shipped surface (including thread/space CRUD and `--space` targeting)
follows a live-captured wire contract; see `research/network/`.

## Install

Requires [Bun](https://bun.sh) ≥ 1.2.

```bash
cd cli
bun install
bun run src/index.ts --help
```

Optional: expose a `pplx` binary —

```bash
npm link        # or: bun link
pplx --help
```

### NixOS / Nix

From the repo root (builds a self-contained bundle; bun is wrapped in via
shebang):

```bash
nix-build                   # ./result/bin/pplx
nix profile install -f .    # install into your profile (also: nix-env -if .)
```

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

## Examples

```bash
# ask — answer streams to stdout while generating; the chat is incognito
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
pplx ask --space "Money Manager" "summarize my spending trends"

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

Ask output: the answer text streams to stdout as it is generated, then a trailing
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
| `PPLX_CONFIG_DIR` | override `~/.config/pplx-cli/` (auth store) |
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
cd cli
bunx tsc --noEmit   # typecheck
bun test            # all tests, zero network (fixtures from research/network)
```

Architecture, wire protocol, and the assumption register live in
[`../research/api-contract.md`](../research/api-contract.md); the build plan in
[`PLAN.md`](PLAN.md).
