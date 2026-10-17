# pi-perplexity — Pi adapter

The repository root is the `pplx` CLI; this package contains only its Pi host
adapter. See root AGENTS.md and docs/pplx-cli-spec.md.

## Stack and boundaries

- TypeScript loaded directly through Pi's jiti loader; no build artifact.
- Node >=18.14.1 platform APIs. No independent HTTP/auth/SSE/config client.
- Invoke installed `pplx` from PATH with argument arrays, stdin ignored, JSON
  stdout and stderr captured separately. Never invoke a checkout CLI path.
- Omit absent options so CLI defaults apply; never read legacy Pi auth/config.
- Tool calls must not prompt. Direct auth failures to terminal `pplx login`.
- Honor AbortSignal, terminate and reap child processes, return readable errors.
- Do not expose CLI credentials/read-write tokens in tool results or logs.
- Host packages are peers with `*`; `Type` and `StringEnum` come from
  `@earendil-works/pi-ai`. No direct typebox or new runtime dependency.
- Consult installed Pi docs for APIs being changed.

## Structure

- `src/index.ts`: default extension factory, `perplexity_search` schema/execution.
- `src/pplx.ts`: argv mapping, installed CLI subprocess, JSON validation/errors.
- `src/format.ts`: LLM-facing answer/citations/session guidance.
- `src/render/`: host-specific call/result TUI renderers.
- `test/`: fake-executable integration and format/render checks.

## Checks (from plugins/pi)

All test/CLI invocations need a fresh HOME, PPLX_CONFIG_DIR, PPLX_CACHE_DIR and
empty PPLX_COOKIE. No live Perplexity requests, including catalogs.

```bash
npm test
npm run typecheck
node --no-deprecation --import ./node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti-register.mjs --input-type=module -e "import('./src/index.ts').then((m)=>{ const entry = m.default?.default ?? m.default; if (typeof entry !== 'function') throw new Error('default export missing'); })"
```

Tests spawn a fake `pplx` at the subprocess seam. Test explicit and omitted
arguments, noninteractive errors, malformed output, and child cancellation.
Do not restore obsolete client tests or access real auth for verification.
