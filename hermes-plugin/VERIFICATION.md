# Hermes plugin verification

Run from repository root:

```bash
npm run typecheck
npm test
python3 hermes-plugin/test_smoke.py
```

The CLI can be smoke-tested without interactive login when valid local credentials are already configured:

```bash
node --no-deprecation \
  --import ./node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti-register.mjs \
  src/cli.ts ask '{"query":"What is 2+2?","limit":1}'
```

For a live-load check, install the plugin into Hermes' user plugin directory, enable it, and verify `perplexity_ask` and `perplexity_deep` appear. Remove the temporary symlink and disable the plugin after the check.

Do not include credentials, account-specific captures, or machine-specific absolute paths in verification notes.
