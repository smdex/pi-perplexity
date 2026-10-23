# pi-perplexity (pplx CLI)

## Layout

- Repository root is the `pplx` CLI package (`src/`, `test/`, `skills/`, `bun.lock`).
- `plugins/pi/` — pi coding-agent extension package (own README and AGENTS.md).
- `plugins/hermes/` — Hermes plugin delegating to the CLI.
- `research/` — captured wire contract (`api-contract.md`) and network fixtures; the source of truth for protocol behavior.
- `docs/pplx-cli-spec.md` — the CLI-first specification this layout implements.

## Stack

- Bun + TypeScript. Runtime deps: `yargs`, `picocolors`, `clipboardy`. Node >= 18 compatible APIs.
- Typecheck: strict, `exactOptionalPropertyTypes`, `types: ["bun-types"]`.

## Commands

```bash
bun install
bunx tsc --noEmit     # typecheck
bun test              # all tests, zero network (fixtures from research/network)
bun test test/sse.test.ts   # single file
```

## Structure

- `src/index.ts` — CLI entry (`bin: pplx`), command registration.
- `src/commands/` — ask, research, chats, spaces, connectors, models, login, completion.
- `src/api/` — HTTP/SSE plumbing against the reverse-engineered web API.
- `src/auth/` — cookie jar login/import (browser profiles, paste, OTP).
- `src/render/` — markdown rendering, spinner.
- `skills/perplexity-cli/SKILL.md` — agent skill shipped alongside the CLI.

## Conventions

- Tests are hermetic: no live Perplexity calls; use fixtures from `test/fixtures.ts` and `research/network`. If a test needs a candidate/remote source, stub it at the boundary (`candidateSources.*`, `mockFetch`).
- Progress and diagnostics go to stderr; stdout stays clean for piping and `--json`.
- Auth lives in `~/.config/pplx-cli/` (`PPLX_CONFIG_DIR` override); caches in `~/.cache/pplx/` (`PPLX_CACHE_DIR`). Never commit auth material.
- Spec: `docs/pplx-cli-spec.md`. Adapters under `plugins/` inherit CLI defaults; they do not keep their own model/connector/space defaults.

## Perplexity Protocol Gotchas

- Endpoint: `POST https://www.perplexity.ai/rest/sse/perplexity_ask`; response is `data:` JSON lines with `[DONE]`, not fully standard SSE.
- Events are incremental snapshots: shallow-merge top level, merge blocks by `intended_usage`, splice markdown via `chunk_starting_offset`, accumulate sources. Completion is `final === true` or `status === "COMPLETED"`.
- Searches default to `is_incognito: true` (disposable temp chats); `--no-incognito` opts into library history.
- Wire details and the assumption register: `research/api-contract.md`.

## Boundaries

### Always

- Pass `AbortSignal` through to network calls; honor cancellation.
- Return user-readable error text; keep exit codes documented in the README.

### Ask First

- Changing Perplexity request headers, model IDs, or auth flow behavior.
- Adding package dependencies or generated build artifacts.

### Never

- Never commit secrets, credentials, `.env`, cached auth tokens, or live response dumps containing private data.
- Never clear cached auth on transient 403/429 responses. A 401 deliberately clears the cookie jar as an invalid session; preserve this tested behavior.
