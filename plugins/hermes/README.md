# Hermes plugin

`perplexity_ask` and `perplexity_research` invoke the installed **`pplx` executable on PATH**. No checkout, ambient Bun, catalog fetch at startup, or separate authentication store is used by the plugin.

Install `pplx` using the repository's CLI installation instructions, then:

```bash
pplx --help
pplx login                      # interactive, in a terminal only
mkdir -p ~/.hermes/plugins
ln -s "$PWD/plugins/hermes" ~/.hermes/plugins/pi-perplexity
hermes plugins enable pi-perplexity
```

Start a new Hermes session. Copying this plugin directory instead of symlinking also works; ensure Hermes inherits a PATH containing `pplx`. Tool invocations have closed stdin and cannot prompt for authentication. Missing/expired authentication directs you to `pplx login`.

## Parameters and settings

Inputs: `query`, `model`, `sources`, `space`, `recency`, `limit` (reference count), `files` (local uploads), `thread` or `continue`, `persistent`, `save`, and `save_images`.

Omitted `model`, `sources`, and `space` inherit CLI settings. Explicit values override those settings using CLI semantics, including research-mode model handling. Sources replace the configured list; `sources: ["web"]` requests web-only scope. Empty source arrays are rejected rather than silently inheriting a configured scope. Space/privacy compatibility is enforced by the CLI; `persistent: true` explicitly enables history. The adapter never changes privacy mode to accommodate a space.

Manage defaults in a terminal with `pplx config get`, `pplx config set`, and `pplx config unset`; CLI settings honor `PPLX_CONFIG_DIR`. The old `/perplexity-config` command and `PI_PERPLEXITY_HOME`/`PI_PERPLEXITY_BUN` settings are removed. Manually transfer desired legacy Pi settings to CLI configuration. Former Pi JWT users must run `pplx login`; legacy auth/config files are not read, converted, deleted, or overwritten.

Output remains TOON with `message`, `references`, `metadata`, and verified saved `file_references`. Errors contain `error` instead. Raw subprocess diagnostics are withheld to avoid exposing cookies or other sensitive output; run `pplx` directly in a terminal for details. Image URLs may expire.

## Cancellation and limits

Hermes' synchronous `tools.interrupt.is_interrupted()` API is polled on the tool-handler thread, without clearing host interrupt state. Children are terminated, escalated to kill after a short grace period, and reaped on cancellation/timeout. POSIX process groups cover wrapper descendants. Standalone use or hosts without that interrupt API retain timeout protection but cannot propagate host cancellation. Non-POSIX descendant cleanup is not guaranteed.

`PI_PERPLEXITY_ASK_TIMEOUT_MS` and `PI_PERPLEXITY_RESEARCH_TIMEOUT_MS` retain their existing timeout controls (90 seconds and 10 minutes by default). Adapter answer streaming is not provided.

See [VERIFICATION.md](VERIFICATION.md) for offline installation/adapter checks and limitations.
