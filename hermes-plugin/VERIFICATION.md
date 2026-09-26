# Hermes plugin verification

Run from repository root:

```bash
npm run typecheck
npm test
python3 hermes-plugin/test_smoke.py
```

The standalone CLI can be exercised with existing cookie auth:

```bash
bun cli/src/index.ts ask --json "What is two plus two?"
bun cli/src/index.ts models --json --all
bun cli/src/index.ts connectors --json
```

For a live-load check, install and enable the plugin in Hermes' user plugin directory, then start a new session and verify `perplexity_ask` and `perplexity_research` appear. Never include credentials, account-specific captures, or machine-specific paths in verification notes.
