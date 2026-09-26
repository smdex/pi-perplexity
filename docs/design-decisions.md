# Design Decisions

## Hermes reuses the TypeScript implementation instead of porting it

The Hermes plugin is a thin Python adapter that validates tool arguments, launches `src/cli.ts`, and returns its JSON result. It deliberately reuses the tested TypeScript authentication, request, SSE, and formatting code rather than maintaining a second Perplexity protocol implementation in Python.

This keeps the reverse-engineered endpoint behavior in one place, avoids new runtime dependencies, and lets Hermes use the same subscription credentials and configuration as pi. The tradeoff is that Hermes needs the pi-perplexity checkout, its installed dependencies, and a resolvable Node/jiti runtime.

## Deep research uses `pplx_alpha`

`perplexity_deep` defaults to the existing `pplx_alpha` model. Deep calls use the same authenticated `perplexity_ask` endpoint and stream-merging path, but expose progress updates and allow an explicit model override. Keeping the deep default explicit avoids silently changing the normal pi model configured by `/perplexity-config` and preserves the intended long-running research behavior.

## Hermes auth is non-interactive

The CLI intentionally calls the existing authentication flow without UI prompt callbacks. It can use a cached token or non-interactive environment credentials, but it never blocks a Hermes tool call waiting for an email or OTP. Auth failures are returned as JSON with instructions to run `/perplexity-login --force` in pi.

## Timeout strategy has two layers

The TypeScript CLI creates an `AbortController` timeout and passes its signal through authentication and network calls. The Python adapter also applies a subprocess timeout. Normal searches default to 90 seconds; deep research defaults to 10 minutes. `PI_PERPLEXITY_ASK_TIMEOUT_MS` and `PI_PERPLEXITY_DEEP_TIMEOUT_MS` configure both layers, so a stuck child process cannot outlive its request budget.

## Hermes integration is opt-in

Hermes discovers user plugins but only loads enabled plugins. The adapter is shipped in `hermes-plugin/` and must be installed and enabled explicitly with `hermes plugins enable pi-perplexity`; it does not alter existing Hermes sessions or tool routing by default.

## AUTH errors do not auto-clear the cached token

When Perplexity returns 401/403 and `SearchError("AUTH")` is thrown, `src/index.ts` returns an error message directing the user to run `/perplexity-login --force`. It does **not** call `clearToken()` automatically.

**Rationale:** A 401 can be transient — network blip, Cloudflare hiccup, clock skew. Auto-clearing on every 4xx would silently discard a still-valid token and force unnecessary re-authentication. The user decides when to re-login. `/perplexity-login --force` clears and re-authenticates in one explicit step.

The token is only cleared when the user explicitly requests it (`--force`) or calls `clearToken()` directly (e.g. in tests or future tooling).
