{
  description = "pplx — Perplexity CLI: ask, deep research, and threads via your Pro/Max web session";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
    # Unstable 26.11 removed Intel Darwin; retain the last supported branch
    # only for that platform, rather than silently dropping its output.
    nixpkgs-intel-darwin.url = "github:NixOS/nixpkgs/nixpkgs-26.05-darwin";
  };

  outputs =
    inputs@{ flake-parts, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];

      perSystem =
        {
          pkgs,
          system,
          self',
          ...
        }:
        let
          pplx = pkgs.callPackage ./package.nix { };
        in
        {
          _module.args.pkgs = import (
            if system == "x86_64-darwin" then inputs.nixpkgs-intel-darwin else inputs.nixpkgs
          ) { inherit system; };

          packages.pplx = pplx;
          packages.default = self'.packages.pplx;

          # Executable acceptance checks for `nix flake check` on native systems.
          checks = {
            pplx-help = pkgs.runCommand "pplx-help" { } ''
              export HOME=$(mktemp -d)
              export PPLX_CONFIG_DIR=$HOME/config PPLX_CACHE_DIR=$HOME/cache PPLX_COOKIE=
              # No ambient Bun or checkout: the installed shebang is sufficient.
              env PATH=/no-ambient-runtime ${pplx}/bin/pplx --help > help.txt
              grep -q 'pplx <command>' help.txt
              test "$(${pplx}/bin/pplx --version)" = '${pplx.version}'
              touch $out
            '';
            pplx-skill = pkgs.runCommand "pplx-skill" { } ''
              cmp ${pplx}/share/pplx/skills/perplexity-cli/SKILL.md \
                ${pplx.src}/skills/perplexity-cli/SKILL.md
              touch $out
            '';
          };
        };
    };
}
