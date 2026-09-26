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
bun cli/src/index.ts ask --recency week --json "What is two plus two?"
```

After enabling the plugin and opening a new Hermes session, check `/perplexity-config list`, set a search model, and verify `perplexity_ask` and `perplexity_research` appear. The tool schemas must not expose `model`; research always uses `pplx_alpha`. Never include credentials, account-specific captures, or machine-specific paths in verification notes.
