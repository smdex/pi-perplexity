# Plan — MCP server for pi-perplexity (fastmcp-ts)

**Status:** DRAFT — pending review. **Do not implement until approved.**
**Library:** `@prefecthq/fastmcp-ts` v1.5.0 (verified API in `docs/research-mcp-server.md`).
**Decisions (locked):** expose `perplexity_search` + `perplexity_deep` tools · launch via `bin` shim · add `@prefecthq/fastmcp-ts` + `zod` as runtime deps.

## Module zoom-out (pre-flight)

- **Module being added:** `src/mcp/` — MCP transport + tool layer. New; no existing callers.
- **Modules being reused (contracts):**
  - `authenticate(opts)` → `StoredToken` (`src/auth/login.ts`). **Caller contract:** non-interactive when prompt callbacks omitted; throws `AuthError` on no credential source.
  - `searchPerplexity(params, auth, signal, onProgress?)` → `SearchResult`, throws `SearchError` (`src/search/client.ts:191`). **Contract:** `params.model` required.
  - `formatForLLM(result, limit?)` → string (`src/search/format.ts:69`).
  - `loadConfig()` / `resolveDefaultModel(config)` (`src/config.ts`). **Contract:** file(`~/.config/pi-perplexity/config.json`) + env(`PI_PERPLEXITY_MODEL`) → default `pplx_pro_upgraded`.
- **Existing callers of reused modules:** pi extension tool (`src/index.ts`), CLI (`src/cli.ts`), Hermes plugin (via CLI subprocess). **No change to any reused module's signature** — pure new consumer. Blast radius = additive only.
- **External API discovery (DISCOVERY MANDATE):** fastmcp-ts API quoted with source permalinks in `docs/research-mcp-server.md`. Key non-obvious facts: package is `@prefecthq/fastmcp-ts` (not unscoped `fastmcp`); `.tool(config, handler)` not `.addTool`; handler gets one positional arg, context via `server.getContext()`; `run()` supports `stdio`|`http` only.

## Slopcheck (external packages)

| Package | Tag | Note |
|---------|-----|------|
| `@prefecthq/fastmcp-ts` | `[OK]` | Mandated by task; PrefectHQ-maintained; API verified against source commit. **Action: confirm `engines.node` ≤ 18.14.1 on install (Task 0).** |
| `zod` | `[OK]` | Already transitively present (via fastmcp-ts dep graph); declaring explicitly because we import it directly. Standard, ubiquitous. |

No `[SUS]`/`[SLOP]`. No new abstraction without reason (see Complexity Pushback below).

## Complexity pushback

| New thing | Reason for depth |
|-----------|------------------|
| `src/mcp/config.ts` (config resolver) | CLI-flag layer must merge with the existing file+env precedence *and* feed both `model` resolution and transport selection — a single coherent precedence chain can't be inlined in two tool handlers without duplication. |
| `bin/pi-perplexity-mcp.js` (shim) | MCP clients need a stable executable entry; the repo has no build step so a jiti-loading shim is the minimal glue (mirrors how Hermes invokes `src/cli.ts`). |

Everything else is inline. No framework, no config library, no DI container.

## Requirement deltas

### `ADDED` — MCP server surface
The package exposes a standalone MCP server (`pi-perplexity-mcp`) that any MCP client (Claude Desktop, Cursor, etc.) can launch over stdio or HTTP. It reuses the same subscription-backed search as the pi extension tool, with no extra credentials and no subprocess.

### `ADDED` — `perplexity_search` MCP tool
Input: `{ query: string (required), recency?: "hour"|"day"|"week"|"month"|"year", limit?: int 1..50 }`. Returns the formatted `## Answer / ## Sources / ## Meta` text identical to the pi tool output. Auth is non-interactive (cached token → env → macOS desktop; no OTP prompts).

### `ADDED` — `perplexity_deep` MCP tool
Input: `{ query, recency?, limit?, model? }`. Long-running research; default model `pplx_alpha` unless `--deep-model`/`PI_PERPLEXITY_DEEP_MODEL`/per-call `model` override; longer timeout; progress logged via MCP notifications.

### `ADDED` — config precedence (file → env → CLI flags)
For each setting, first defined value wins, order: **CLI flag → env → file → default**. (Existing `config.ts` already does file→env→default for `model`; this adds the CLI-flag tier on top.)

| Setting | CLI flag | Env | File | Default |
|---------|----------|-----|------|---------|
| model | `--model` | `PI_PERPLEXITY_MODEL` | `model` | `pplx_pro_upgraded` |
| deep model | `--deep-model` | `PI_PERPLEXITY_DEEP_MODEL` | — | `pplx_alpha` |
| config path | `--config <path>` | — | — | `~/.config/pi-perplexity/config.json` |
| transport | `--transport stdio\|http` | `MCP_TRANSPORT` | — | `stdio` |
| host/port/path | — | `MCP_HOST`/`MCP_PORT`/`MCP_PATH` | — | fastmcp defaults |

### `MODIFIED` — (none)
No existing module's behavior changes. All reuse is additive.

---

## Tasks

> Each task = one outcome, leaves repo working, one runnable `verify:`.
> `status:` starts `failing`; flips to `passing` only after verify exits 0. Risk → Allure severity: P0→critical, P1→high, P2→normal, P3→minor.

### Task 0 — Dependency install + engine check
Add `@prefecthq/fastmcp-ts` and `zod` to `package.json` `dependencies`; `npm install`. Confirm `@prefecthq/fastmcp-ts` `engines.node` is satisfiable by the repo's `>=18.14.1` floor (if higher, STOP and surface).
- **risk:** P1 · **security:** low · **allure:** { severity: high, categories: [Dependencies] }
- → verify: `node -e "const p=require('./node_modules/@prefecthq/fastmcp-ts/package.json'); console.log(p.version, p.engines||'no-engines')" && npm run typecheck`

### Task 1 — Config resolver (`src/mcp/config.ts`)
Implement `resolveMcpConfig(argv?)`: parse `--model`, `--deep-model`, `--config <path>`, `--transport`, `--host`, `--port`, `--path` via `node:util` `parseArgs`. Returns `{ model, deepModel, transport, host?, port?, path?, runOptions }`. Precedence flag>env>file>default. Reuses `loadConfig(configPath)` + a new model resolver that layers `--model`/`PI_PERPLEXITY_MODEL` over `resolveDefaultModel`. Exports pure functions (no I/O at import time) so tests can drive precedence without touching the real filesystem. Export an injectable `loadConfig` seam.
- **risk:** P2 · **security:** none · **allure:** { severity: normal, categories: [Unit, Config] }
- → verify: `npm run test:build && node --test --experimental-test-module-mocks ".tmp-test/test/mcp/config.test.js"`

### Task 2 — Tool-handler core (`src/mcp/tools.ts`)
Implement two pure async functions `runSearchTool(args, deps, signal)` and `runDeepTool(args, deps, signal)` returning a string (formatted text) or throwing a typed error. Mirror `cli.ts` `runSearch`: non-interactive `authenticate({signal})`, timeout signal from env (`PI_PERPLEXITY_ASK_TIMEOUT_MS` 90s / `PI_PERPLEXITY_DEEP_TIMEOUT_MS` 600s), `searchPerplexity` → `formatForLLM(result, limit)`. Catch `AuthError`/`SearchError` → return readable error string (never throw to host). Define a `ToolDeps` interface (injectable `authenticate`, `searchPerplexity`, `loadConfig`, `resolveModel`, `formatForLLM`) mirroring `cli.ts` `CliDependencies` for testability.
- **risk:** P1 · **security:** none · **allure:** { severity: high, categories: [Unit, Tools] }
- → verify: `npm run test:build && node --test --experimental-test-module-mocks ".tmp-test/test/mcp/tools.test.js"`

### Task 3 — Server factory + entry (`src/mcp/server.ts`)
`createServer(config, deps?)`: `new FastMCP({ name: "pi-perplexity", version })`; register `perplexity_search` + `perplexity_deep` via `server.tool({ name, description, input: z.object(...) }, handler)` where handler calls Task 2 functions, wires `AbortSignal`/progress via `server.getContext()`. `main(argv?)`: resolve config → `createServer` → `await server.run(runOptions)`. Guard `main()` invocation behind `import.meta.url === fileURLToPath(process.argv[1])` (matches `cli.ts:266`).
- **risk:** P1 · **security:** none · **allure:** { severity: high, categories: [Integration] }
- → verify: `npm run typecheck && npm run test:build && node --test --experimental-test-module-mocks ".tmp-test/test/mcp/server.test.js"`

### Task 4 — Bin shim + package wiring
Create `bin/pi-perplexity-mcp.js`: `node` shim that imports jiti register from `node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti-register.mjs` (only path where jiti exists in this repo), then `import('../src/mcp/server.ts')` → call `main()`. Add `package.json` `"bin": { "pi-perplexity-mcp": "bin/pi-perplexity-mcp.js" }` and add `bin/` to `"files"`. **Boundary check:** confirm fastmcp-ts resolves at runtime under jiti (no ESM/CJS interop issues); if it fails, surface before proceeding.
- **risk:** P1 · **security:** low · **allure:** { severity: high, categories: [Smoke] }
- → verify: `node bin/pi-perplexity-mcp.js --help 2>&1 | grep -q . ; test $? -eq 0` (server should start not crash on --help) — AND a stdio `tools/list` smoke: `printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' '{"jsonrpc":"2.0","method":"notifications/initialized"}' '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | timeout 5 node bin/pi-perplexity-mcp.js 2>/dev/null | grep -q perplexity_search`

### Task 5 — README MCP section
Add `## MCP server` section to `README.md`: install, bin usage, Claude Desktop/Cursor JSON config snippet (stdio command), flags/env/config table, auth note (must run `/perplexity-login` first; non-interactive under MCP).
- **risk:** P3 · **security:** none · **allure:** { severity: minor, categories: [Docs] }
- → verify: `grep -q "pi-perplexity-mcp" README.md && grep -q "MCP server" README.md`

### Task 6 — Full verification gate
Whole-repo typecheck + full test suite green (existing 73 tests still pass + new mcp tests). Confirm no secrets, AbortSignal threaded, errors-as-text.
- **risk:** P2 · **security:** low · **allure:** { severity: normal, categories: [Regression] }
- → verify: `npm run typecheck && npm test 2>&1 | tail -8` → all pass, fail 0.

---

## Test plan (new)

- `test/mcp/config.test.ts` — precedence matrix (flag>env>file>default) for `model` and `deepModel`; `--config <path>` override; transport `stdio`/`http` selection + invalid value rejection; env-var isolation per test.
- `test/mcp/tools.test.ts` — `runSearchTool`/`runDeepTool` happy path returns formatted text; `AuthError` → readable error string (not throw); `SearchError` → readable error string; `limit` honored; deep uses `pplx_alpha` default + per-call `model` override; signal abort respected. Uses `ToolDeps` fakes (no network).
- `test/mcp/server.test.ts` — `createServer` registers exactly two tools named `perplexity_search`/`perplexity_deep`; tool input schemas reject missing `query`. (FastMCP instance introspected; no live run.)

## Boundaries (AGENTS.md) — flagged for approval

1. **New runtime deps** (Task 0) — `@prefecthq/fastmcp-ts` + `zod`. Task-mandated; user-approved in clarifying Q.
2. **Bin field + `files`** (Task 4) — adds an executable surface. First `bin` in this package.
3. **Auth flow behavior unchanged** — MCP path omits prompt callbacks (already supported by `authenticate`); no modification to `src/auth/`. Within "Always" boundaries.

## Failure-recovery discipline

- Any task verify failing → root-cause, fix, re-verify (never shotgun).
- After 3 consecutive failures on one task → stop, revert to last green `npm test`, surface to user.
- fastmcp-ts runtime/jiti interop (Task 4) is the highest-risk unknown; isolated first by the Task 4 boundary check before later tasks depend on it.

## Handoff

Plan ready → review (multi-lens) → user approval → `kickoff-branch` → implement Task 0..6 in order.
