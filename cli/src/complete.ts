import type { Argv } from "yargs";
import { MODELS } from "./constants.js";
import { listThreadStates, readCache, writeCache } from "./config.js";
import { listSpacesMentions } from "./api/spaces.js";
import { listConnectors } from "./api/sources.js";
import { fetchModelCatalog } from "./api/models.js";
import { sidebarThreads } from "./api/graphql.js";

/**
 * Async shell completion (plan §4.12, cli-libs.md): generated scripts call
 * `pplx --get-yargs-completions …` at TAB time; the handler resolves which
 * option's VALUE is being completed and serves live candidates from a 10-minute
 * TTL cache. Completion must never error — fetch failures degrade to empty
 * candidate lists (and yargs' default flag/subcommand completion).
 */

const CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Which option's value is pending completion? `current` is only the word being
 * typed; inspect parsed argv: the option whose value (scalar, or last array
 * element) === current is pending. Words starting with "-" are flag completion.
 */
export function pendingOption(argv: Record<string, unknown>, current: string): string | null {
  if (current.startsWith("-")) return null;
  for (const [key, value] of Object.entries(argv)) {
    if (key === "_" || key === "$0") continue;
    if (value === current) return key;
    if (Array.isArray(value) && value[value.length - 1] === current) return key;
  }
  return null;
}

/**
 * TTL-cached candidate fetch: hit → return; miss → fetcher() → writeCache →
 * return; fetcher throws → [] (offline/auth errors must not break TAB).
 */
export async function cached<T>(key: string, fetcher: () => Promise<T[]>): Promise<T[]> {
  const hit = await readCache<T[]>(key, CACHE_TTL_MS);
  if (hit !== null && Array.isArray(hit)) return hit;
  try {
    const fresh = await fetcher();
    await writeCache(key, fresh).catch(() => {});
    return fresh;
  } catch {
    return [];
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((v) => v.length > 0))];
}

export type CandidateSource = () => Promise<string[]>;

/** Candidate providers per option name (overridable in tests). */
export const candidateSources: Record<string, CandidateSource> = {
  // live catalog (24h cache via fetchModelCatalog + 10min completion cache) —
  // falls back to the bundled slugs when the endpoint is unreachable
  model: async () => {
    try {
      return (await fetchModelCatalog()).models.map((m) => m.id);
    } catch {
      return MODELS.map((m) => m.id);
    }
  },
  sources: () => cached("sources", () => listConnectors().then((c) => c.map((x) => x.id))),
  // both title and uuid resolve (resolveSpace) — offer both
  space: () => cached("spaces", () => listSpacesMentions().then((s) => s.flatMap((x) => [x.title, x.uuid]))),
  thread: () =>
    cached("threads", async () => {
      const local = (await listThreadStates()).map((t) => t.slug);
      let remote: string[] = [];
      try {
        remote = (await sidebarThreads()).map((n) => n.slug ?? n.entryId ?? "");
      } catch {
        // sidebar needs auth/network; local slugs alone still complete offline
      }
      return unique([...local, ...remote]);
    }),
  // positional <ref> for chats subcommands: titles (what users type) + slugs
  chatRef: () =>
    cached("chatRefs", async () => {
      const local = (await listThreadStates()).flatMap((t) => [t.query ?? "", t.slug]);
      let remote: string[] = [];
      try {
        remote = (await sidebarThreads()).flatMap((n) => [n.title ?? "", n.slug ?? n.entryId ?? ""]);
      } catch {
        // offline: local titles/slugs only
      }
      return unique(local.concat(remote));
    }),
  // positional <ref> for spaces subcommands — same candidates as --space
  spaceRef: () => candidateSources.space(),
};

/** `pplx <words…> <current>` — which subcommand's positional <ref> is pending? */
const REF_COMMANDS: Record<string, keyof typeof candidateSources> = {
  "chats show": "chatRef",
  "chats rename": "chatRef",
  "chats delete": "chatRef",
  "chats pin": "chatRef",
  "chats unpin": "chatRef",
  "threads show": "chatRef",
  "threads rename": "chatRef",
  "threads delete": "chatRef",
  "threads pin": "chatRef",
  "threads unpin": "chatRef",
  "spaces threads": "spaceRef",
  "spaces rename": "spaceRef",
  "spaces delete": "spaceRef",
};

type DoneFn = (completions: string[]) => void;
type FilterFn = () => void;

/**
 * The completion handler. Argument order differs across yargs versions: the
 * runtime passes (current, argv, completionFilter, done) but older docs put
 * `done` third — distinguish by arity (completionFilter has an optional
 * parameter → length 0; done callbacks take one argument).
 */
export function completionHandler(
  current: string,
  argv: Record<string, unknown>,
  a: unknown,
  b: unknown,
): void {
  let completionFilter: FilterFn | null = null;
  let done: DoneFn | null = null;
  for (const candidate of [a, b]) {
    if (typeof candidate !== "function") continue;
    const arity = (candidate as (...args: unknown[]) => unknown).length;
    if (arity === 0 && completionFilter === null) completionFilter = candidate as FilterFn;
    else if (done === null) done = candidate as DoneFn;
  }
  // positional <ref> completion: "pplx chats rename <TAB>" — argv._ holds the
  // typed words; the ref is pending when it is word #3 (or word #3 slot is empty).
  // Checked BEFORE pendingOption: a parsed positional named `ref` would otherwise
  // be mistaken for a pending option (its value === current).
  const words = Array.isArray(argv._) ? argv._.map(String) : [];
  const cmd = words.slice(0, 2).join(" ");
  const refSource =
    words.length === 3 || (words.length === 2 && current === "")
      ? REF_COMMANDS[cmd]
      : undefined;
  const key = refSource === undefined ? pendingOption(argv, current) : null;
  const source = refSource !== undefined ? candidateSources[refSource] : key !== null ? candidateSources[key] : undefined;
  if (source !== undefined) {
    void source()
      .then((all) => {
        const needle = current.toLowerCase();
        done?.(all.filter((c) => c.toLowerCase().startsWith(needle)));
      })
      .catch(() => done?.([]));
  } else {
    completionFilter?.();
  }
}

/**
 * Wire the `--get-yargs-completions` machinery. The internal command name is
 * hidden; users get `pplx completion <shell>` (buildCompletionCommand) which
 * emits an explicit shell script instead of yargs' $SHELL-based guess.
 */
export function buildCompletion(y: Argv): Argv {
  return y
    .option("get-yargs-completions", {
      type: "boolean",
      hidden: true,
      // Never let strict()/demandCommand validation reject the completion probe.
      skipValidation: true,
    } as never)
    .completion("__pplx_completions__", false, completionHandler);
}

// ---------------------------------------------------------------- script generation

export type ShellName = "bash" | "zsh" | "fish";

export function shellFromEnv(): ShellName {
  const shell = process.env.SHELL ?? "";
  if (shell.includes("zsh")) return "zsh";
  if (shell.includes("fish")) return "fish";
  return "bash";
}

/**
 * Quote an executable path for embedding in generated shell source — a path
 * containing shell metacharacters (spaces, quotes, `$`, `;`…) would otherwise
 * execute as code when the completion script is sourced. Plain paths stay bare
 * so the scripts stay readable; the `'…'\\''…'` form is valid in bash/zsh/fish.
 */
export function shellQuote(path: string): string {
  if (/^[A-Za-z0-9_\/.\-+=:@%]+$/.test(path)) return path;
  return "'" + path.replaceAll("'", "'\\''") + "'";
}

const SCRIPTS: Record<ShellName, (appPath: string) => string> = {
  bash: (appPath) => `###-begin-pplx-completions-###
#
# pplx completion script (bash)
#
# Installation: pplx completion bash >> ~/.bashrc
#    or pplx completion bash >> ~/.bash_profile on OSX.
#
_pplx_yargs_completions()
{
    local cur_word args type_list

    cur_word="\${COMP_WORDS[COMP_CWORD]}"
    args=("\${COMP_WORDS[@]}")

    # ask pplx to generate completions.
    # see https://stackoverflow.com/a/40944195/7080036 for the spaces-handling awk
    mapfile -t type_list < <(${shellQuote(appPath)} --get-yargs-completions "\${args[@]}")
    mapfile -t COMPREPLY < <(compgen -W "$( printf '%q ' "\${type_list[@]}" )" -- "\${cur_word}" |
        awk '/ / { print "\\""$0"\\"" } /^[^ ]+$/ { print $0 }')

    # if no match was found, fall back to filename completion
    if [ \${#COMPREPLY[@]} -eq 0 ]; then
      COMPREPLY=()
    fi

    return 0
}
complete -o bashdefault -o default -F _pplx_yargs_completions pplx
###-end-pplx-completions-###
`,
  zsh: (appPath) => `#compdef pplx
###-begin-pplx-completions-###
#
# pplx completion script (zsh)
#
# Installation: pplx completion zsh > ~/.zfunc/_pplx && echo 'fpath=(~/.zfunc $fpath)' >> ~/.zshrc
#
_pplx_yargs_completions()
{
  local reply
  local si=$IFS
  IFS=$'\\n' reply=($(COMP_CWORD="$((CURRENT-1))" COMP_LINE="$BUFFER" COMP_POINT="$CURSOR" ${shellQuote(appPath)} --get-yargs-completions "\${words[@]}"))
  IFS=$si
  if [[ \${#reply[@]} -gt 0 ]]; then
    _describe 'values' reply
  else
    _default
  fi
}
if [[ "\${zsh_eval_context[-1]}" == "loadautofunc" ]]; then
  _pplx_yargs_completions "$@"
else
  compdef _pplx_yargs_completions pplx
fi
###-end-pplx-completions-###
`,
  fish: (appPath) => `###-begin-pplx-completions-###
#
# pplx completion script (fish)
#
# Installation: pplx completion fish > ~/.config/fish/completions/pplx.fish
#
complete -f -c pplx -a '(${shellQuote(appPath)} --get-yargs-completions (commandline -o)[2..-1])'
###-end-pplx-completions-###
`,
};

/** Completion script for an explicit shell (path = how the CLI was invoked). */
export function completionScript(shell: ShellName, appPath?: string): string {
  const path = appPath ?? process.argv[1] ?? "pplx";
  return SCRIPTS[shell](path);
}
