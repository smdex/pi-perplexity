# Hermes plugin verification

Verified from `/home/smaximov/gh/pi-perplexity` on 2026-08-13. No gateway was restarted.

## Commands and results

- `npm ci` — PASS. Installed 238 packages from the lockfile. npm reported four audit findings (two moderate, two high); no dependency was added to the project.
- `npm run typecheck` — PASS (standalone preflight).
- `npm test` — PASS (standalone preflight): **72 passed, 1 skipped, 0 failed**.
- `npm run typecheck && npm test` — PASS (final chained check). TypeScript typecheck passed; tests reported **72 passed, 1 skipped, 0 failed**.
- Python import smoke:

  ```bash
  python3 - <<'PY'
  import importlib.util
  from pathlib import Path
  path = Path('hermes-plugin/__init__.py')
  spec = importlib.util.spec_from_file_location('pi_perplexity_hermes_plugin', path)
  assert spec is not None and spec.loader is not None
  module = importlib.util.module_from_spec(spec)
  spec.loader.exec_module(module)
  assert callable(module.register)
  print('python import-smoke: PASS (register callable)')
  PY
  ```

  PASS: `register` is callable.
- `python3 hermes-plugin/test_smoke.py` — PASS: `hermes-plugin smoke tests passed`.
- Non-interactive CLI smoke (a cached auth token was present):

  ```bash
  node --no-deprecation --import ./node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti-register.mjs src/cli.ts ask '{"query":"What is 2+2?","limit":1}'
  ```

  PASS: returned `ok: true`, answer text, and JSON output without prompting.
- `HERMES_PLUGINS_DEBUG=1 hermes plugins list` and `HERMES_PLUGINS_DEBUG=1 hermes tools list` — PASS: Hermes discovery commands completed. Before installation, the plugin was not present in the user plugin directory, as expected.
- Reversible live-load check: symlinked `hermes-plugin` to `~/.hermes/plugins/pi-perplexity`, ran `hermes plugins enable pi-perplexity`, then ran `HERMES_PLUGINS_DEBUG=1 hermes tools list`. PASS: debug output showed `pi-perplexity` loaded and registered `perplexity_ask` and `perplexity_deep`; the tools list showed `pi_perplexity`. The symlink was removed and the temporary Hermes enablement was disabled afterward.
- Cleanup check: `~/.hermes/plugins/pi-perplexity` — PASS: symlink absent after the live-load check.
- `git diff --check` — PASS.
- Helper-file check — PASS: the temporary `.iter1-report.md` and `.iter2-report.md` files were removed; this verification file remains.

The live search smoke used an existing credential but did not print or modify the credential. No interactive login was attempted.

## Resolved Node + jiti recipe

The adapter resolves the agent-nested jiti register first, then the hoisted fallback. In this checkout the resolved file is:

```text
/home/smaximov/gh/pi-perplexity/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti-register.mjs
```

The exact absolute invocation recipe is:

```bash
cd /home/smaximov/gh/pi-perplexity
node --no-deprecation \
  --import /home/smaximov/gh/pi-perplexity/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti-register.mjs \
  /home/smaximov/gh/pi-perplexity/src/cli.ts \
  ask '{"query":"latest TypeScript release","limit":5}'
```

Use `deep` in place of `ask` for the deep tool, or `auth-status` with no JSON argument. The Hermes adapter supplies the same command with the selected subcommand and compact JSON arguments.

## Copy-paste installation

From a pi-perplexity checkout:

```bash
cd /home/smaximov/gh/pi-perplexity
npm ci
mkdir -p ~/.hermes/plugins
ln -s "$PWD/hermes-plugin" ~/.hermes/plugins/pi-perplexity
# Alternatively, copy instead of symlinking:
# cp -R "$PWD/hermes-plugin" ~/.hermes/plugins/pi-perplexity
export PI_PERPLEXITY_HOME="$PWD"
hermes plugins enable pi-perplexity
hermes plugins list --plain --no-bundled | rg pi-perplexity
```

Start a new Hermes session after enabling the plugin. Authenticate separately through pi (`/perplexity-login`) or provide the non-interactive credentials supported by pi-perplexity. Do not commit `~/.config/pi-perplexity/auth.json` or any other credentials.
