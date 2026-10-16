# CLI-first Perplexity specification

Status: scope confirmed; implementation not started.

## Goal and decisions

Make `pplx` the primary product and sole implementation of Perplexity requests, authentication, response merging, and user defaults. The skill, Pi extension, and Hermes plugin use that CLI rather than maintaining separate clients.

Confirmed decisions:
- Breaking repository, installation, and configuration changes are acceptable. Do not add legacy path shims.
- Pi and Hermes become thin adapters that invoke `pplx`.
- Add a flake based on `flake-parts` and `nixos-unstable`.
- Target Linux and Darwin on x86_64 and aarch64. This interprets the user's confirmation of Linux/Darwin support; successful evaluation is not proof of native runtime support.

## 1. Repository and integration boundaries

Target layout:

```text
package.json                 # pplx-cli package, bin: pplx
bun.lock
src/                         # current cli/src
test/                        # current cli/test
skills/perplexity-cli/
plugins/pi/                  # thin TypeScript Pi adapter
plugins/hermes/              # thin Python Hermes adapter
package.nix
default.nix                  # existing non-flake entry
flake.nix
flake.lock
docs/
research/
```

- Move the CLI manifest, lockfile, sources, tests, and skill to the root. Preserve existing CLI commands and capabilities except for the changes specified here.
- Replace the Pi client's independent auth/search/config implementation with CLI delegation. Keep useful host-specific tool schemas and rendering; do not retain duplicate network code.
- Update Hermes to invoke the installed `pplx` executable instead of `bun <checkout>/cli/src/index.ts`. Both adapters use `pplx` from PATH; report an actionable installation error when it is missing.
- Invoke subprocesses with argument arrays, not shell interpolation. Consume existing machine-readable CLI output and translate errors into host-readable tool results. Propagate cancellation and terminate child processes without exposing credentials.
- Normal adapter tool calls are noninteractive. Missing or expired authentication directs users to `pplx login` in a terminal rather than hanging on an OTP prompt.
- Both adapters inherit CLI defaults when callers omit options. They must not inject their own default model, connector list, or space. Explicit tool parameters override CLI defaults.
- Use the CLI cookie authentication store. Document reauthentication for former Pi JWT users; do not convert, delete, or overwrite old auth/config files automatically.
- Update Nix packaging, CI, publish workflows, installation instructions, skill references, and applicable agent instructions together. Remove active references to obsolete checkout entry paths.
- Adapter packages contain only their host-specific dependencies. Do not introduce a workspace framework or shared-client package solely for this move.

Acceptance: root CLI tests/typecheck pass; adapters invoke a fake `pplx` successfully in tests; omitted/default and explicit arguments behave correctly; missing executable, nonzero exit, malformed output, and cancellation produce useful results. Document and smoke-test each new installation path. Do not publish packages during implementation.

## 2. Response streaming

Reported symptom: the CLI writes approximately 10–15 characters, then waits until the answer completes.

Investigation found that `cli/src/commands/ask.ts` only emits updates when the merged answer extends the already printed prefix. Diverging updates are suppressed. The merger in `cli/src/api/sse.ts` also needs verification against actual event semantics. These are code-reading findings, not a reproduced root cause.

Required behavior:
- Verify merger semantics before changing them. Distinguish snapshots, patches, and chunk updates; do not assume every event contains either a full answer or a delta.
- Interactive terminal output updates throughout answer generation, including for single-paragraph answers without newlines. Changed snapshots must not cause a silent stall until completion.
- When the server revises existing text, redraw the current answer safely rather than appending duplicate answers. Preserve surrounding terminal output and restore terminal state on completion, error, or cancellation.
- For redirected stdout, emit the final answer once without terminal controls or stale prefixes. Buffering redirected output is intentional: previously emitted bytes cannot be retracted after a server rewrite.
- Keep progress and diagnostics on stderr. Preserve structured JSON and saved-result correctness; do not intermix progress with machine-readable output.
- Completion is based on the protocol, not the first nonempty text. Cancellation and truncated streams must not be presented as successful complete answers.

Acceptance: deterministic tests cover incremental updates before completion, shrink/rewrite/regrowth, repeated snapshots, single-line answers, and multibyte text. Add merger cases for the event forms demonstrated by evidence. Terminal tests prove visible updates before completion and correct final display; redirected/JSON/save tests prove one correct final result without ANSI or duplicate prefixes. Include abort/error cleanup tests.

If live evidence is needed, use an explicitly approved, non-sensitive query. Keep raw captures local; commit only sanitized minimal fixtures. This spec does not authorize live requests or private-response capture.

Adapter answer streaming is not required in this iteration. Pi/Hermes may return the complete structured CLI result while preserving cancellation and host progress reporting.

## 3. Shared defaults

Add persistent CLI settings at `~/.config/pplx-cli/config.json`, honoring the existing `PPLX_CONFIG_DIR` override:

- `model`: the default model identifier.
- `sources`: the default source/connector identifier list, matching existing CLI terminology.
- `space`: the default space, resolved using the CLI's existing space semantics.

Provide `pplx config get`, `set`, and `unset`, with discoverable help and examples. Keep auth material separate from settings.

- Precedence is explicit invocation option, then saved setting, then the existing command's built-in default. Preserve command-specific semantics such as research mode; do not add a separate research-model setting unless implementation proves it necessary.
- Explicit source lists replace configured lists; they do not append implicitly. Provide a documented invocation-level way to bypass configured connectors and a configured space without editing the settings file.
- Validate settings shape and values. Reject unsupported keys and malformed writes without destroying the existing file. Use restrictive permissions and an atomic replacement when saving.
- Do not silently fall back from an invalid or unavailable configured connector/space to a different search scope. Report a useful error and do not submit the unintended request.
- Do not silently change incognito/history behavior to satisfy a configured space. Verify compatibility and report an actionable conflict when necessary.
- Pi/Hermes must not continue reading the legacy Pi settings or maintaining competing defaults. Document manual migration and leave old files untouched.

Acceptance: test persisted defaults, explicit overrides, unset behavior, bypassing space/connectors, alternate config directory, malformed input/file handling, safe writes, unavailable configured resources, and privacy conflicts. Adapter tests verify inheritance rather than hardcoded defaults.

## 4. Nix flake

- Add `flake.nix` using `flake-parts` with `nixpkgs` from `github:NixOS/nixpkgs/nixos-unstable`; commit `flake.lock`.
- Expose `packages.<system>.pplx` and `packages.<system>.default` for `x86_64-linux`, `aarch64-linux`, `x86_64-darwin`, and `aarch64-darwin`.
- Reuse `package.nix`; update its CLI-root source/version/skill paths. Keep the existing `default.nix` entry working with the same derivation.
- Install `bin/pplx` and `share/pplx/skills/perplexity-cli/SKILL.md`. The installed command must use its packaged Bun runtime, with no checkout, ambient Bun, or development dependencies required.
- Dependency fetching stays in fixed-output derivations. The main build is sandboxed and requires no network, authentication, or user settings. Filter local/generated files from packaged source.
- No NixOS module, Home Manager module, overlay, or development-shell overhaul is required.

Acceptance: evaluate all four package outputs; run `nix flake check`, `nix build .#pplx`, `nix build`, and `nix run .#pplx -- --help`. Native build/runtime checks are required to claim a platform verified; report unavailable builders explicitly. Check the packaged skill and existing non-flake entry. Do not report cross-platform evaluation as cross-platform runtime testing.

## Implementation sequence

1. Establish existing CLI baseline and reproduce streaming with a deterministic regression; obtain sanitized live evidence only if authorized and necessary.
2. Move the CLI to root and update affected paths, packaging, documentation, and CI.
3. Add shared defaults and cover precedence, scope, privacy, and write safety.
4. Replace Pi/Hermes clients with CLI adapters and fake-process integration tests; remove their obsolete client code.
5. Fix verified merger/output defects and test terminal versus redirected rendering.
6. Add the locked flake and validate package outputs on available native builders.
7. Run affected tests/typechecks, plugin installation smoke checks, and Nix checks; report untested platforms and live-service behavior separately.

## Out of scope

Legacy installation shims, automatic token/config migration, new MCP integrations, unrelated scaffold cleanup, new Perplexity features, package publication, remote deployment, and incremental answer transport for host adapters.
