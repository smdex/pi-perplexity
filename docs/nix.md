# Nix packaging

The flake uses flake-parts and locked `nixos-unstable`. It exposes
`packages.<system>.pplx` and `packages.<system>.default` for `x86_64-linux`,
`aarch64-linux`, and `aarch64-darwin`: exactly three supported systems, all
using `github:NixOS/nixpkgs/nixos-unstable`.

## Unsupported Intel Darwin

`x86_64-darwin` is unsupported because current nixpkgs unstable 26.11 dropped
it and rejects evaluation with `Nixpkgs 26.11 has dropped support for
x86_64-darwin.` There is no stable-input fallback. This three-system scope
is the user-approved exception to the original four-platform specification.
Evaluation of an output is not a native runtime guarantee.

## Build and install

```sh
nix build .#pplx
nix build                        # same default package
nix run .#pplx -- --help
nix profile install .#pplx
```

`bin/pplx` has a store-pinned Bun shebang. The package needs neither ambient
Bun nor a checkout or development dependencies. The agent skill is installed
at `share/pplx/skills/perplexity-cli/SKILL.md`.

`default.nix` remains a non-flake entry using the same `package.nix`:

```sh
nix-build                        # uses your <nixpkgs>
# Or explicitly use the flake's locked native nixpkgs:
nix-build --arg pkgs '(builtins.getFlake (toString ./.)).inputs.nixpkgs.legacyPackages.${builtins.currentSystem}'
```

The filtered build source contains only the root manifest, lockfile, `src/`,
and `skills/`, excluding plugins, tests, local settings, and `node_modules`.
Production dependencies are fetched with the frozen Bun lockfile in a
fixed-output derivation. The bundle build uses those dependencies offline;
keep Nix sandboxing enabled. Public build inputs may need downloading; no
Perplexity requests or authentication are needed to build or check help.

## Verification

```sh
for system in x86_64-linux aarch64-linux aarch64-darwin; do
  nix eval --raw .#packages.$system.pplx.drvPath
  nix eval --raw .#packages.$system.default.drvPath
done
nix flake check --all-systems --no-build  # evaluation only
nix flake check                         # checks for the native system
nix build .#pplx
nix build
nix run .#pplx -- --help
cmp result/share/pplx/skills/perplexity-cli/SKILL.md skills/perplexity-cli/SKILL.md
```

The flake checks run installed help without ambient Bun, check the version,
and compare the installed skill against the source. CLI checks use isolated
HOME/config/cache directories and an empty `PPLX_COOKIE`. No authenticated
command is part of package verification. Run native build/runtime checks on
each target before claiming that platform verified; `--all-systems --no-build`
only checks evaluation, and does not supply missing builders.
