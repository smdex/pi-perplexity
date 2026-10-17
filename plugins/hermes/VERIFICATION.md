# Offline Hermes verification

From repository root, with Python 3 available (no Python dependencies):

```bash
d=$(mktemp -d)
HOME="$d" PPLX_CONFIG_DIR="$d/config" PPLX_CACHE_DIR="$d/cache" PPLX_COOKIE= \
  python3 plugins/hermes/test_smoke.py
rm -rf "$d"
```

Tests register the real tools and invoke real fake PATH executables with isolated state and EOF on stdin. They cover inherited/explicit parameters, literal option-looking queries, TOON/references/saved files, missing executable, authentication/nonzero/malformed errors, credential-safe diagnostics, timeout, pre-cancellation, TERM-resistant child reaping, and pipe-heavy output.

Optionally set `HERMES_INTERRUPT_SOURCE` to the installed host's `tools/interrupt.py` source to exercise its actual thread-scoped interrupt API, including concurrent unaffected sessions. This loads only that module with a stand-in environment helper, not Hermes startup/config/auth/history. Without it, that one test is explicitly skipped; cancellation tests still use a boundary stand-in.

The CLI currently does not bind tokens after `--` to its required variadic positional query. The adapter therefore passes the query as one argv element, prefixing a space only for option-looking queries; the CLI already trims positional queries. This avoids interpreting query text as flags without changing submitted text. No shell is used.

Installation smoke coverage is offline: registration plus execution against a PATH fake works without a checkout cwd or Bun. These checks do not prove live Perplexity behavior, a full interactive Hermes session, other Hermes versions, or non-POSIX descendant cleanup. No live catalog/authenticated queries are needed or authorized.
