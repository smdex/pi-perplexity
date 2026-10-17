# Hermes plugin (pi-perplexity)

The Hermes plugin exposes `perplexity_ask` and `perplexity_research`. Unlike a skill (which only instructs the agent to run shell commands), the plugin provides typed, discoverable tools. It delegates to the standalone **Bun `pplx` CLI** at the repository root, so it shares that CLI's cookie login, connectors, uploads, thread handling, and model catalog. It does **not** use the Pi extension's separate auth store.

```bash
bun install                # at the repository root
bun src/index.ts login --status
mkdir -p ~/.hermes/plugins
ln -s "$PWD/plugins/hermes" ~/.hermes/plugins/pi-perplexity
hermes plugins enable pi-perplexity
```

Sign in with `bun src/index.ts login` from the repository root if needed, then start a new Hermes session. Set `PI_PERPLEXITY_HOME` to the checkout root if copying the plugin elsewhere; `PI_PERPLEXITY_BUN` can override the Bun executable. The plugin caches live search-model and connected-connector IDs at startup (with an offline fallback); restart Hermes to refresh them. `PI_PERPLEXITY_ASK_TIMEOUT_MS` and `PI_PERPLEXITY_RESEARCH_TIMEOUT_MS` control subprocess limits (90 seconds and 10 minutes by default).

Inputs: `query`, `sources` (web, scholar, social, finance, or connected GitHub), `recency`, `limit`, `files` (local uploads), `thread` or `continue`, `space`, `persistent` (default false/incognito), `save`, and `save_images`. Output is TOON with `message`, `references`, `metadata`, and `file_references` (verified saved paths where available); error responses contain `error` instead. Image URLs may expire.

The agent cannot choose a model. Use `/perplexity-config list` to see recommended search models (GPT-6 Sol, Gemini 3.8 Flash, Kimi K3, Claude Sonnet 5, Grok 4.7, Claude Opus 5.5), `/perplexity-config all` for the full live catalog, `/perplexity-config <model-id>` to set one, or `/perplexity-config reset` to restore the CLI default. The command shares the Pi extension's `~/.config/pi-perplexity/config.json`; research always uses `pplx_alpha`.

For occasional interactive CLI use, the repository's `skills/perplexity-cli` skill is sufficient. Choose the plugin when you want these named tools available to Hermes automatically.


> The plugin is being converted to invoke an installed `pplx` executable rather
> than a checkout path — see `docs/pplx-cli-spec.md` in the repository root.
