# Prior Art — MCP server (fastmcp-ts)

Task: add an MCP server that exposes pi-perplexity over MCP, with config resolved
from **file → env → CLI flags**. Library mandated by task: PrefectHQ/fastmcp-ts.

## Outcome matrix

| Candidate | Source | Fit | Verdict |
|-----------|--------|-----|---------|
| `@prefecthq/fastmcp-ts` | github.com/PrefectHQ/fastmcp-ts @ v1.5.0 (commit `ed1082bc`) | adopt | Use as the MCP framework |
| Existing `src/cli.ts` `runSearch` | this repo | compose | Reuse auth+search+format in-process; the MCP tool mirrors `runSearch` but without a subprocess |
| Existing `src/config.ts` `loadConfig` / `resolveDefaultModel` | this repo | extend | Already does file+env for `model`; extend with a CLI-flag layer for the MCP server |
| Node `util.parseArgs` | node:util (runtime, no dep) | adopt | fastmcp-ts ships NO app-config loader; parse CLI flags ourselves |
| fastmcp `MCP_TRANSPORT`/`MCP_HOST`/`MCP_PORT`/`MCP_PATH` env | built into fastmcp-ts | adopt | Built-in transport config; do not reimplement |

**Overall verdict: compose.** fastmcp-ts is adopted as the framework (no MCP protocol to
hand-roll); the tool body reuses the existing search/auth/format stack in-process; a thin
config resolver layers CLI flags on top of the existing file+env resolution.

## fastmcp-ts API (verified against source, commit ed1082bc)

**Package is `@prefecthq/fastmcp-ts`, NOT the unscoped `fastmcp`** (that is
`punkpeye/fastmcp`, a different project). Install:

```bash
npm install @prefecthq/fastmcp-ts zod
```

- Import: `import { FastMCP } from "@prefecthq/fastmcp-ts/server"`
- Construct: `new FastMCP({ name, version })` (`name` required, `version` defaults `"0.0.1"`)
- Register tool: `server.tool({ name, description, input: z.object({...}) }, (args) => result)`
  - **`.tool(...)`, not `.addTool(...)`**
  - Handler receives **one positional arg** (validated input). There is **no** `(args, ctx)` signature.
  - Request context obtained *inside* the handler via `server.getContext()` → `ctx.info()/.error()/.log()`, `ctx.auth`, `ctx.requestId`. `getContext()` throws outside a live handler.
- Start: `await server.run()` (stdio by default) or `await server.run({ transport: "http", host, port, path })`.
  - **Transports: `stdio` | `http` only.** No standalone SSE; `sse` is rejected by `run()`.
  - No `startStdio()`/`startHttp()`/`startSSE()` methods.
- **No application-config loader.** fastmcp-ts resolves only its own transport env (`MCP_TRANSPORT`, `MCP_HOST`, `MCP_PORT`, `MCP_PATH`, `FASTMCP_STATELESS_HTTP`) and bundles `citty`/`yaml` for *its* CLI. App config (model, file loading, custom flags) is user-supplied.

Minimal form (from README):

```ts
import { FastMCP } from "@prefecthq/fastmcp-ts/server";
import { z } from "zod";

const server = new FastMCP({ name: "pi-perplexity", version: "0.4.0" });
server.tool(
  { name: "perplexity_search", description: "...",
    input: z.object({ query: z.string().min(1) }) },
  async ({ query }) => { /* ... */ return "text"; },
);
await server.run();
```

## Reusable internal surface (no protocol porting needed)

The MCP tool is the in-process twin of `src/cli.ts`'s `runSearch` (which the Hermes plugin
already drives via subprocess JSON). Reuse directly:

- `authenticate({ signal })` (`src/auth/login.ts`) → `StoredToken`. **Non-interactive**: omit
  `promptForEmail`/`promptForOtp`; relies on cached token (`~/.config/pi-perplexity/auth.json`) →
  env (`PI_PERPLEXITY_TOKEN`/`_COOKIE`/`_EMAIL`/`_OTP`) → macOS desktop. Throws `AuthError`
  ("NO_TOKEN") with no credential source — surface as readable error text (mirror cli.ts).
- `searchPerplexity(params, auth, signal, onProgress?)` (`src/search/client.ts:191`)
  - `params: { query; model; recency?: "hour"|"day"|"week"|"month"|"year" }`
  - `auth: StoredToken` (`AuthCredentials` is private; import `StoredToken`)
  - returns `SearchResult { answer; sources: WebResult[]; displayModel?; uuid? }`, throws `SearchError`
- `formatForLLM(result, limit?)` (`src/search/format.ts:69`) — produces the same `## Answer / ## Sources / ## Meta` text the pi tool returns.
- `loadConfig()` / `resolveDefaultModel(config)` (`src/config.ts`) — file (`~/.config/pi-perplexity/config.json`) + env (`PI_PERPLEXITY_MODEL`) → default `pplx_pro_upgraded`.
- Timeouts already env-driven in cli.ts (`PI_PERPLEXITY_ASK_TIMEOUT_MS` default 90s, `PI_PERPLEXITY_DEEP_TIMEOUT_MS` default 600s, deep model `pplx_alpha`).

## Config resolution design (file → env → CLI flags)

Priority order (highest first). For each setting, the first defined value wins.

| Setting | CLI flag | Env | File (`config.json`) | Default |
|---------|----------|-----|----------------------|---------|
| model | `--model` | `PI_PERPLEXITY_MODEL` | `model` | `pplx_pro_upgraded` |
| deep model | `--deep-model` | `PI_PERPLEXITY_DEEP_MODEL` | — | `pplx_alpha` |
| config file path | `--config <path>` | — | — | `~/.config/pi-perplexity/config.json` |
| transport | `--transport` | `MCP_TRANSPORT` | — | `stdio` |
| host/port/path | — | `MCP_HOST`/`MCP_PORT`/`MCP_PATH` | — | fastmcp defaults |

File + env layers already exist (`config.ts`); the only new layer is a `parseArgs`-based
flag parser (`src/mcp/config.ts`) that feeds `resolveDefaultModel`'s precedence and selects
the fastmcp transport. zod (already transitively present) becomes a declared dependency for
the tool input schemas.

## Boundaries flagged (require sign-off per AGENTS.md)

1. **New runtime deps**: `@prefecthq/fastmcp-ts` + declaring `zod`. Extension is loaded via
   jiti with no build step, so fastmcp-ts must resolve at runtime from `node_modules`.
2. **Launch mechanism**: no `bin` field / `exports` map exists. MCP clients need a way to
   start the TS server under jiti (bin shim vs documented `node --import jiti ...` vs
   `fastmcp run`).
3. **Auth is non-interactive** under MCP — no prompts; unauthenticated → error text pointing
   at `/perplexity-login`. No change to auth flow behavior, just no UI callbacks.
```
