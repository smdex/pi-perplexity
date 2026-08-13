{
  description = "pi-perplexity — Perplexity web search for pi, plus a standalone MCP server";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
  };

  outputs =
    inputs@{ flake-parts, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];

      perSystem =
        {
          self',
          pkgs,
          lib,
          ...
        }:
        {
          # The standalone MCP server is the only artifact that makes sense as a
          # Nix package: it depends on nothing from the pi host (verified: its
          # import graph reaches only node:* builtins, @prefecthq/fastmcp-ts,
          # and zod). The extension entry in src/index.ts is not packaged — it
          # is consumed at runtime by the pi coding agent.
          packages.pi-perplexity-mcp = pkgs.callPackage ./nix/package.nix {
            src = ./.;
            nodejs = pkgs.nodejs_22;
          };
          packages.default = self'.packages.pi-perplexity-mcp;

          devShells.default = pkgs.mkShell {
            packages = [ pkgs.nodejs_22 ];
            shellHook = ''
              echo "pi-perplexity dev shell: node $(node --version), npm $(npm --version)"
            '';
          };

          # Building the package is itself the primary check. The unit test
          # suite needs the dev-only @earendil-works/pi-coding-agent tree and a
          # writable node_modules, so it stays a `nix develop` + `npm test`
          # concern rather than a sandboxed check.
          checks.default = self'.packages.pi-perplexity-mcp;
        };
    };
}
