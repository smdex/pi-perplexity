# pi-perplexity — Pi extension

A thin [Pi](https://pi.dev) adapter for the installed `pplx` CLI. The CLI alone
handles Perplexity requests, cookie authentication, response merging, sessions,
and saved defaults. A Perplexity Pro/Max web subscription is required.

## Installation

1. Install the CLI using the [repository instructions](../../README.md#install).
   Ensure `pplx --help` works on the **PATH inherited by Pi**. The CLI installation
   supplies its runtime; this extension does not invoke Bun or a checkout path.
2. From a checkout, register this package:

   ```bash
   pi install /absolute/path/to/pi-perplexity/plugins/pi
   ```

   The standalone published Pi package uses `pi install npm:pi-perplexity`.
   Installing the repository root as a Pi package is no longer supported.
3. Authenticate in a terminal, outside tool execution:

   ```bash
   pplx login --paste          # import browser cookies; see CLI instructions
   ```

Restart Pi or use `/reload` after changing its environment or extension.
Tool calls never prompt for email/OTP and never launch login. Missing or expired
credentials return instructions to run `pplx login` in a terminal.

## Tool

The agent calls `perplexity_search`:

| Parameter | Meaning |
|---|---|
| `query` | Required search text |
| `model` | Explicit model override (`pplx models` lists identifiers) |
| `sources` | Source/connector identifiers replacing CLI defaults |
| `space` | Explicit space title or UUID |
| `incognito` | Explicit privacy choice; `false` retains the chat in history |
| `recency` | `hour`, `day`, `week`, `month`, or `year` |
| `files` | Local attachment paths, relative to the Pi session directory |
| `thread` | CLI thread slug or URL to continue |
| `continue` | Continue the latest live CLI session |
| `limit` | Maximum citations to display (1–50); does not change search scope |

Omitted options are not passed to `pplx ask --json`, so CLI settings and built-in
defaults apply. There is no independent Pi model/source/space configuration.
An empty `sources` list is rejected rather than silently inheriting a saved
scope; use `["web"]` for web-only search or omit the option to inherit defaults. Space/privacy conflicts are reported by the CLI;
the adapter never silently disables incognito mode for a space.

Results contain Answer, numbered Sources, optional Images and Follow-ups, and
Meta sections. Meta includes the CLI session identifier when available; session
state is managed only by the CLI. Complete structured results are returned
rather than incremental answer streaming. Pi displays progress while waiting;
cancellation terminates the child (and its owned process group on POSIX), with
SIGTERM then SIGKILL after five seconds if needed, and awaits its exit. CLI failures return readable text and error details
for the tool renderer, not raw exceptions or credentials.

## Migrating from the old Pi client

The `/perplexity-login`, `/perplexity-config`, and `/perplexity-threads` commands
are removed. Use `pplx login`, `pplx config`, and `pplx chats` in a terminal.

Old Pi JWT credentials, settings, environment variables (`PI_PERPLEXITY_*`), and
session caches are **not read, converted, deleted, or overwritten**. Reauthenticate
with CLI cookie login, even if the old extension was already logged in. Manually
copy any desired model setting into `pplx config set model MODEL`; likewise set
`sources` and `space` using `pplx config --help`. CLI settings and authentication
are separate files under `~/.config/pplx-cli/` (`PPLX_CONFIG_DIR` override), and
CLI sessions/caches use `PPLX_CACHE_DIR`. Existing old Pi-only sessions may need
to be restarted in the CLI.

## Development

From `plugins/pi` with the existing development dependencies available:

```bash
npm test
npm run typecheck
node --no-deprecation --import ./node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti-register.mjs --input-type=module -e "import('./src/index.ts').then((m)=>{ const entry = m.default?.default ?? m.default; if (typeof entry !== 'function') throw new Error('default export missing'); })"
```

Tests use a fake installed `pplx`, never the live service. The CLI parser
regression also requires the repository's Bun runtime and root CLI sources; it
runs with fresh empty authentication and expects a login error before networking. No new runtime
dependency is required; Pi supplies its host packages and the adapter uses Node
18.14.1+ subprocess APIs.

## License and disclaimer

MIT — see [LICENSE](LICENSE). The CLI uses an undocumented web API which can
change without notice and may violate Perplexity's terms. Use at your own risk.
