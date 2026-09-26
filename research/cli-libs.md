# CLI Stack — `pplx` (Bun + TypeScript)

Research date: 2026-09-22. Versions checked live via `npm view` on that date.
Deciding factor per task: **async shell completion with dynamic candidates** (model/connector/chat/space names fetched from the API).

## Chosen stack

| Concern | Choice | Version | Notes |
|---|---|---|---|
| Argument parsing + completion | **yargs** | 18.2.0 (published 2026-09-20) | built-in async completion, bash+fish+zsh scripts, ships own TS types |
| Colors / styling | **picocolors** | 1.1.1 | 3.8 kB, zero deps, `NO_COLOR` respected, works under Bun |
| Spinner while SSE pending | none (inline ~30 lines) | — | writes to **stderr**, stopped before streaming answer to stdout; see below |
| Clipboard | **clipboardy** | 5.3.2 | pure ESM, spawns platform binaries (pbcopy/wl-copy/xclip/clip.exe), handles WSL |

Planned `cli/package.json` deps: `yargs`, `picocolors`, `clipboardy`. Nothing else.

## Argument parsing: comparison

Verified facts, not folklore:

| | yargs 18.2.0 | commander 15.0.0 | cac 7.0.0 | cliffy (npm 2.5.1 / deno cliffy) | citty 0.2.2 |
|---|---|---|---|---|---|
| **Async dynamic completion** | ✅ built-in: sync return, Promise, or `done` callback; `completionFilter` 4th arg to fall back to default subcommand/flag candidates | ❌ none (README/docs have no completion section) | ❌ none | ❌ on npm: **`cliffy` 2.5.1 is a different, stale 2018 package** (drew-y/cliffy, TS 3.1, vorpal-like REPL). The Deno cliffy (c4spar) has **no npm release** — only alpha forks (`@dotrex/command` 0.0.0-alpha.2, "fork of cliffy/command for bun/node") | ❌ none — grepped `unjs/citty` src: no completion module at all; README silent |
| Generated shell scripts | ✅ `pplx completion` emits bash/zsh/fish, verified below | ❌ DIY | ❌ DIY | ✅ (Deno runtime) | ❌ DIY |
| Programmatic completion (testable without a shell) | ✅ `yargs.getCompletion(['pplx','ask','--model',''], cb)` — **verified under Bun 1.4.2** | — | — | — | — |
| Subcommand DSL | ✅ `.command("ask <query>")` builder pattern | ✅ | ⚠️ flat, minimal | ✅ (Deno) | ⚠️ defineCommand objects |
| Maintenance | active (2026-09 release) | active (2026-09) | quiet but stable | npm namesake dead; Deno-first | maintenance mode (unjs focus moved to **gunshi** 0.37.3) |
| Under Bun 1.4.2 | ✅ verified hands-on | ✅ (fine) | ✅ | ⚠️ alpha forks only | ✅ |

### Why yargs

1. **Completion is the deciding factor and yargs is the only mainstream choice with it built in.**
   - Handler receives `(current, argv, done, completionFilter)`. Async supported three ways (return Promise, call `done`, use `completionFilter` to merge with yargs' default candidates). Verified live:
     ```js
     yargs(hideBin(process.argv))
       .completion("completion", function (current, argv, done) {
         if (pendingOption(argv, current) === "space")
           fetchSpaces().then(done);          // live GET /rest/spaces/mentions
         else done(["ask", "chats", "spaces"]); // or fall through to completionFilter()
       })
       .parse();
     ```
   - Generated scripts call back into the binary at TAB time (`pplx --get-yargs-completions …`), so candidates can be fetched live — exactly what we need.
2. **Testable without a shell.** `getCompletion(args, cb)` runs the same handler programmatically → bun tests with fixture data, no bash needed. Matches the repo's test discipline.
3. **Boring.** 15+ years old, ships its own TypeScript types (no `@types` peer), ESM+CJS dual, runs under Bun (verified 18.2.0 hands-on).

Runner-up worth noting: **gunshi** (unjs, 0.37.3) has an official `@gunshi/plugin-completion`, but 0.x, younger API, smaller ecosystem; yargs wins on provenness for the same feature.

## Completion mechanism sketch

### How the generated scripts work (verified output of `pplx completion`)

bash:
```bash
_pplx_yargs_completions() {
    local cur_word args type_list
    cur_word="${COMP_WORDS[COMP_CWORD]}"
    args=("${COMP_WORDS[@]}")
    mapfile -t type_list < <(pplx --get-yargs-completions "${args[@]}")
    mapfile -t COMPREPLY < <(compgen -W "$( printf '%q ' "${type_list[@]}" )" -- "${cur_word}" |
        awk '/ / { print "\""$0"\"" } /^[^ ]+$/ { print $0 }')   # quotes candidates w/ spaces
    return 0
}
complete -o bashdefault -o default -F _pplx_yargs_completions pplx
```

zsh:
```zsh
#compdef pplx
_pplx_yargs_completions() {
  local reply; local si=$IFS
  IFS=$'\n' reply=($(COMP_CWORD="$((CURRENT-1))" COMP_LINE="$BUFFER" COMP_POINT="$CURSOR" \
      pplx --get-yargs-completions "${words[@]}"))
  IFS=$si
  if [[ ${#reply} -gt 0 ]]; then _describe 'values' reply; else _default; fi
}
if [[ "${zsh_eval_context[-1]}" == "loadautofunc" ]]; then
  _pplx_yargs_completions "$@"     # fpath autoload: pplx completion > ~/.zfunc/_pplx
else
  compdef _pplx_yargs_completions pplx
fi
```

Install UX: `pplx completion bash >> ~/.bashrc` · zsh: `mkdir -p ~/.zfunc && pplx completion zsh > ~/.zfunc/_pplx && fpath=(~/.zfunc $fpath)`. `-o bashdefault -o default` in bash keeps **filename completion** for `--attach` when the handler returns no candidates.

### Pending-option detection (the one tricky part, verified)

`current` is only the word being completed. To know *which option's value* is pending, inspect parsed `argv` — verified behavior:

| user typed | `current` | `argv` | rule |
|---|---|---|---|
| `pplx ask --mo<TAB>` | `--mo` | `{_: ["pplx","ask"], mo: true}` | starts with `-` → flag completion (use `completionFilter` default) |
| `pplx ask --model <TAB>` | `""` | `{model: ""}` | key whose value `=== current` is pending → dynamic candidates |
| `pplx ask --space Mone<TAB>` | `Mone` | `{space: "Mone"}` | same |
| `pplx ask --sources we<TAB>` | `we` | `{sources: ["we"]}` | array option: last element `=== current` |

```ts
function pendingOption(argv: { [k: string]: unknown }, current: string): string | null {
  if (current.startsWith("-")) return null;              // completing a flag itself
  for (const [k, v] of Object.entries(argv)) {
    if (k === "_" || k === "$0") continue;
    if (v === current) return k;                          // scalar option
    if (Array.isArray(v) && v[v.length - 1] === current) return k; // array option
  }
  return null;                                            // positional → default completion
}
```

### Candidate providers (1 call each, with TTL cache)

Completion latency matters (~TAB is interactive). Cache JSON at `~/.cache/pplx/completions.json`, TTL 10 min, served instantly; refresh in background after emitting. bun single-file startup ≈ 20–40 ms + one cached read.

| completing | source | candidates |
|---|---|---|
| `--space` | `GET /rest/spaces/mentions` | `{spaces:[{uuid,title}]}` → **titles** (bash script quotes "Money Manager"; we resolve title→uuid at runtime; fall back to uuid) |
| `--model` | live `/rest/models/config` (bundled fallback; API-INDEX §models) | catalog of `model_preference` slugs (e.g. `gemini38flash`) |
| `--sources` | `GET /rest/sources?limit=40&group_by_family=true` | `id`s: `web`, `scholar`, `google_drive`, `github_mcp_direct`, … |
| `--thread` | GraphQL `SidebarRecentItemsRelayQuery` (recent 20) | thread uuids (+ slug hint) |
| `--attach` | — | none returned → bash `-o default` gives filename completion |
| subcommands / flags | yargs built-in (`completionFilter()`) | `ask`, `chats`, `spaces`, `login`, … and `--model`, `--incognito`, … |

### Skeleton of the completion module

```ts
// cli/src/completion.ts
import yargs from "yargs";

type CandidateSource = () => Promise<string[]>;

export const candidateSources: Record<string, CandidateSource> = {
  space:    () => cache("spaces", () => getSpaceMentions().then(s => s.spaces.map(x => x.title))),
  model:    () => cache("models", async () => MODELS),                    // static
  sources:  () => cache("sources", () => getSources().then(s => s.map(x => x.id))),
  thread:   () => cache("threads", () => getRecentThreads().then(t => t.map(x => x.uuid))),
};

export function buildCompletion(y: yargs.Argv): yargs.Argv {
  return y.completion("completion", async (current, argv, done, completionFilter) => {
    const key = pendingOption(argv, current);
    if (key && candidateSources[key]) {
      done((await candidateSources[key]()).filter(c => c.startsWith(current)));
    } else {
      completionFilter();            // subcommands + flags from the command tree
    }
  });
}
```

### Testability (bun test, no shell)

```ts
// cli/test/completion.test.ts — fixture-backed, zero network
const completions = await new Promise<string[]>((res) =>
  y.getCompletion(["pplx", "ask", "--space", ""], (_e, c) => res(c!)));
```

## Terminal output / streaming decision

Constraint: `ask`/`research` stream answer text to **stdout** while the request is in flight. Anything that also writes to stdout mid-stream corrupts output (and breaks `pplx ask … | tee answer.md`).

- **picocolors 1.1.1** — chosen for styling. No deps, fastest, `NO_COLOR`, stream-agnostic. In practice color only when `picocolors.isColorSupported` / stdout.isTTY.
- **Spinner: inline, ~30 lines, stderr-only.** `setInterval` → `\r⠙ waiting for stream…` to `process.stderr`; clear + stop on first SSE event. stderr/stdout separation keeps piped stdout clean and needs no dependency. Spinner glyphs via picocolors.
- **nanospinner 1.2.2** — rejected: writes to `process.stdout` (fights SSE output), single style.
- **cli-progress 3.12.0** — rejected for now (not deleted from consideration): it's a *bar* library, but our only long-transfer (S3 attachment PUT) is via `fetch`, which exposes **no upload progress** — there's nothing real to render a bar from. Revisit only if we add chunked multipart with progress later.

## Clipboard decision

- **clipboardy 5.3.2** — chosen. Pure ESM, zero native code, spawns the right platform binary (`pbcopy`, `wl-copy`, `xclip -selection clipboard`, `clip.exe`, WSL-aware). Used by `pplx ask … --copy` / `chats show --copy` (copy final markdown).
- Alternative considered: 25-line helper wrapping platform binaries via `Bun.spawn` (zero deps). Deferred — clipboardy already is that helper with the edge cases handled; one boring dep.

## Command surface (wire-up sketch)

```ts
// cli/src/index.ts
yargs(hideBin(process.argv))
  .scriptName("pplx")
  .option("cookie",   { type: "string", hidden: true }) // global escape hatch
  .command("login", "auth via cookie / browser token / OTP", loginCmd)
  .command("chats",  "list | show — library threads",        chatsCmd)   // chats list [--space <id>]; chats show <id> [--out md]
  .command("spaces", "list | create | delete | rename",      spacesCmd)
  .command("models", "list model_preference ids",            modelsCmd)  // client-bundled list
  .command("connectors", "list source/connector ids",        connectorsCmd)
  .command("threads", "alias of chats (CRUD)",               chatsCmd)
  .command("ask <query..>", "search / ask; streams to stdout", askCmd)
  .option("thread",    { type: "string" })   // follow-up: last_backend_uuid chain
  .option("incognito", { type: "boolean", default: true })
  .option("model",     { type: "string" })
  .option("sources",   { type: "array" })    // web,scholar,google_drive,…
  .option("attach",    { type: "array" })    // presign → S3 POST → subscribe → attachments[]
  .option("space",     { type: "string" })
  .command("research <query..>", "deep research mode (search_mode: research)", askCmd)
  .command("completion [shell]", "emit bash|zsh|fish completion script", completionCmd)
  .demandCommand(1)
  .strict()
  .parse();
```

`research` reuses the ask client with the deep-research mode field (`search_mode: "research"` / computer-menu skill `deep-research` per b-summary) — single askCmd with a mode flag internally.

## eliminated options summary

- **commander 15** — best-in-class parsing UX, but zero completion story; bolting on tabtab (stale) or omelette = a second dependency doing worse what yargs does natively.
- **cac 7** — lovely and tiny, no completion, no subcommand ergonomics we need.
- **cliffy** — the good cliffy never shipped to npm; the npm `cliffy` is an unrelated dead package; Bun support exists only in alpha forks. Disqualifying for a Bun-first CLI.
- **citty 0.2.2** — no completion at all; maintenance mode (successor: gunshi).
- **gunshi 0.37.3** — has completion plugin, but 0.x; kept as the "if yargs ever bites us" fallback.
