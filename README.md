# pi-perplexity

A [pi](https://github.com/badlogic/pi-mono) extension that gives your coding agent real-time web search powered by your **Perplexity Pro or Max subscription**
## Requirements

- [pi](https://github.com/badlogic/pi-mono) coding agent with its bundled Node runtime (Node 18.14.1+ if running outside pi)
- A **Perplexity Pro** or **Max** subscription
- macOS (for zero-interaction auth), an interactive terminal (for email OTP), or a signed-in browser session cookie/token

## Installation

```bash
pi install npm:pi-perplexity
```

Or from GitHub:

```bash
pi install github:ivanrvpereira/pi-perplexity
```

## Hermes plugin

This repository also includes an opt-in [Hermes Agent](https://github.com/NousResearch/hermes-agent) adapter. It exposes the existing subscription-backed pi-perplexity implementation as two Hermes tools: `perplexity_ask` for a normal search and `perplexity_deep` for long-running research (default model: `pplx_alpha`). The adapter is dependency-free and invokes the repository's TypeScript CLI rather than porting the search protocol to Python.

Install it from a pi-perplexity checkout:

```bash
mkdir -p ~/.hermes/plugins
ln -s "$PWD/hermes-plugin" ~/.hermes/plugins/pi-perplexity
# Or copy it instead:
# cp -R "$PWD/hermes-plugin" ~/.hermes/plugins/pi-perplexity
export PI_PERPLEXITY_HOME="$PWD"
hermes plugins enable pi-perplexity
```

Set `PI_PERPLEXITY_HOME` to the checkout containing `src/cli.ts` and `node_modules`; it is required when the plugin is copied and recommended for a symlink as well. The plugin is opt-in and takes effect in a new Hermes session. Its runtime knobs are:

| Variable | Description |
|---|---|
| `PI_PERPLEXITY_NODE` | Node executable to run (defaults to `node`) |
| `PI_PERPLEXITY_ASK_TIMEOUT_MS` | Normal-search subprocess timeout (defaults to 90,000 ms) |
| `PI_PERPLEXITY_DEEP_TIMEOUT_MS` | Deep-research subprocess timeout (defaults to 600,000 ms) |

## MCP server

pi-perplexity also ships a standalone [Model Context Protocol](https://modelcontextprotocol.io) server, so any MCP client — Claude Desktop, Cursor, etc. — can use your Perplexity subscription for web search. It reuses the same search stack as the pi extension, with no subprocess and no extra credentials.

**Requires Node >= 22** on the host running the server (the `@prefecthq/fastmcp-ts` runtime requirement). This is independent of the pi extension, which keeps the Node >= 18.14.1 floor.

Authenticate once first (see [Authentication](#authentication)):

```text
pi /perplexity-login
```

### Claude Desktop / Cursor

Add the server to your MCP client config. For stdio (recommended):

```json
{
  "mcpServers": {
    "pi-perplexity": {
      "command": "npx",
      "args": ["-y", "pi-perplexity-mcp"]
    }
  }
}
```

To run from a checkout instead, point the command at the bin shim:

```json
{
  "mcpServers": {
    "pi-perplexity": {
      "command": "node",
      "args": ["/path/to/pi-perplexity/bin/pi-perplexity-mcp.js"]
    }
  }
}
```

### Nix

A `flake.nix` (using [flake-parts](https://flake.parts)) builds the MCP server as a Nix package. From a checkout:

```bash
nix build .#pi-perplexity-mcp
./result/bin/pi-perplexity-mcp --help
nix run .#pi-perplexity-mcp -- --help
```

There is also a dev shell providing Node 22 + npm:

```bash
nix develop
```

The derivation restores only the runtime dependencies (`@prefecthq/fastmcp-ts`, `jiti`, `zod`) — the pi-host peer deps and dev tree are omitted — and wraps the binary with Node 22 on `PATH`. Point an MCP client at `result/bin/pi-perplexity-mcp` in place of `npx`.

### Tools

| Tool | Description |
|---|---|
| `perplexity_search` | Web search with a synthesized answer and numbered source citations. Params: `query` (required), `recency` (`hour`\|`day`\|`week`\|`month`\|`year`), `limit` (1–50). |
| `perplexity_deep` | Longer-running research using the `pplx_alpha` model (overridable per call via `model`), with a longer timeout and progress notifications. Same params as `perplexity_search` plus optional `model`. |

Both tools always run incognito. Authentication is non-interactive under MCP: if no cached token, env credential, or macOS desktop token is available, the tool returns a readable error directing you to run `pi /perplexity-login`.

### Configuration

Settings resolve in priority order: **CLI flag → environment variable → config file → default**. The config file is the same `~/.config/pi-perplexity/config.json` used by the pi extension.

| Setting | Flag | Env | File | Default |
|---|---|---|---|---|
| search model | `--model <id>` | `PI_PERPLEXITY_MODEL` | `model` | `pplx_pro_upgraded` |
| deep model | `--deep-model <id>` | `PI_PERPLEXITY_DEEP_MODEL` | — | `pplx_alpha` |
| config path | `--config <path>` | — | — | `~/.config/pi-perplexity/config.json` |
| transport | `--transport stdio\|http` | `MCP_TRANSPORT` | — | `stdio` |
| http host | `--host <addr>` | `MCP_HOST` | — | `127.0.0.1` |
| http port | `--port <n>` | `MCP_PORT` / `PORT` | — | `3000` |
| http path | `--path <path>` | `MCP_PATH` | — | `/mcp` |

For the HTTP transport, the server binds to loopback by default and **refuses non-loopback hosts** unless you pass `--allow-public` or set `PI_PERPLEXITY_ALLOW_PUBLIC=1`. Only enable this behind a trusted reverse proxy with MCP authentication — the server processes your Perplexity credentials.

```bash
pi-perplexity-mcp --help
```

## Authentication

Run login once:

```text
/perplexity-login
```

This usually reuses an existing cached login, borrows the Perplexity macOS app login if available, or asks for your email OTP code.

If login fails with a Cloudflare “Just a moment...” page, use browser login instead:

```text
/perplexity-login --browser
```

### Browser login

Use this on Linux/headless machines when direct OTP is blocked.

1. Open `https://www.perplexity.ai` and sign in.
2. Open browser DevTools → **Network**.
3. Reload the page, or ask one Perplexity question.
4. Right-click a `www.perplexity.ai` request, preferably `perplexity_ask`.
5. Choose **Copy** → **Copy as cURL**.
6. Paste the copied cURL command into the pi prompt.

The copied text must include cookies. A good copy contains one of `-b`, `--cookie`, or `Cookie:`, and should include `__Secure-next-auth.session-token`. If it does not, copy a different request.

You can also paste just the request `Cookie:` header, or just the `__Secure-next-auth.session-token` cookie value. Full cURL is recommended because it also includes Cloudflare cookies like `cf_clearance`.

The token is saved to `~/.config/pi-perplexity/auth.json` (mode `0600`) and reused across sessions. On auth failure, run `/perplexity-login --force` to clear and re-authenticate.

### Environment variables

| Variable | Description |
|---|---|
| `PI_AUTH_NO_BORROW=1` | Skip macOS desktop app extraction and go straight to email OTP |
| `PI_PERPLEXITY_TOKEN` | Raw Perplexity session token/JWT/JWE copied from a browser or another machine |
| `PI_PERPLEXITY_COOKIE` / `PI_PERPLEXITY_COOKIES` | Full Perplexity `Cookie` header copied from a signed-in browser |
| `PI_PERPLEXITY_EMAIL` | Pre-fill the email prompt (useful for non-interactive setups) |
| `PI_PERPLEXITY_OTP` | Pre-fill the OTP prompt |

## Usage

Once installed, the agent automatically calls `perplexity_search` whenever it needs current information. You can also ask it directly:

> "Search Perplexity for the latest React 19 release notes"

### Tool parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | ✅ | The search query |
| `recency` | string | — | Filter by age: `hour` · `day` · `week` · `month` · `year` |
| `limit` | number | — | Max sources to include (1–50) |

Model selection is configured globally with `/perplexity-config` or `PI_PERPLEXITY_MODEL`; it is not exposed as a tool parameter, so agent-generated tool calls cannot accidentally override your configured model.

### Output format

The tool returns structured text the agent can reason over:

```
## Answer
React 19 introduces Actions, use() hook, and improved Server Components...

## Sources
3 sources
[1] React 19 Release Notes (1d ago)
    https://react.dev/blog/2024/12/05/react-19
    React 19 is now stable. This release includes Actions for async...

[2] What's New in React 19 (3d ago)
    https://vercel.com/blog/react-19
    A deep dive into the new primitives landing in React 19...

## Meta
Provider: perplexity (oauth)
Model: pplx_pro_upgraded
```

Queries always send `is_incognito: true`, so searches never appear in your Perplexity web history.

## How It Works

The extension calls Perplexity's internal SSE endpoint (`perplexity_ask`) using your subscription credentials obtained from the macOS app, email OTP, or a browser-imported session. Responses stream as incremental events that are merged into a final result. Network calls use the Node runtime already provided by pi; no extra runtime is required. Email OTP auth requires `Headers.getSetCookie()` support so auth cookies are exposed reliably.

## Development

```bash
npm install          # Install dev dependencies
npm test             # Run tests
npm run typecheck    # Type check
```

Optional live model-selection E2E test (requires cached auth from `/perplexity-login`):

```bash
PI_PERPLEXITY_E2E=1 npm test
PI_PERPLEXITY_E2E=1 PI_PERPLEXITY_E2E_MODELS=pplx_pro_upgraded,gpt54 npm test
```

## License

MIT — see [LICENSE](LICENSE) for details.

---

## Disclaimer

This project is intended for **educational and demonstration purposes only**. It reverse-engineers an undocumented internal endpoint and uses credentials borrowed from the Perplexity macOS desktop app. This likely violates Perplexity's Terms of Service. Use at your own risk — your account may be suspended. The author makes no warranties and accepts no liability for any consequences of its use.
