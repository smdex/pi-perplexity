# Nix derivation for the standalone pi-perplexity MCP server.
#
# The server is TypeScript loaded at runtime via jiti (no compile step), so the
# "build" is really just: restore the runtime node_modules from the lockfile and
# stage src/ + bin/. Only the three runtime deps (@prefecthq/fastmcp-ts, jiti,
# zod) are needed — verified that the server's import graph never reaches the
# @earendil-works/* peer deps the pi host normally provides — so we omit dev
# dependencies. --legacy-peer-deps keeps npm from erroring on the unsatisfied
# (and unused) pi-tui/pi-ai peers once the dev tree is pruned.
{
  lib,
  buildNpmPackage,
  makeWrapper,
  nodejs,
  src,
}:

buildNpmPackage {
  pname = "pi-perplexity-mcp";
  version = "0.4.0";

  inherit src;

  # npm cache + node resolution use Node 22 (fastmcp-ts runtime requirement).
  inherit nodejs;

  nativeBuildInputs = [ makeWrapper ];

  # Recompute with `nix build .#pi-perplexity-mcp`; the first run reports the
  # correct sha256 when this placeholder fails to match.
  npmDepsHash = "sha256-VrfzQGBAl66Ec92CBSKyanKy2LmguCe9NaF95iEfCMw=";

  dontNpmBuild = true;
  npmFlags = [
    "--omit=dev"
    "--legacy-peer-deps"
  ];

  # The bin shebang is `#!/usr/bin/env node`; pin Node 22 on PATH so the wrapper
  # is self-contained regardless of the caller's environment.
  postFixup = ''
    wrapProgram "$out/bin/pi-perplexity-mcp" \
      --prefix PATH : ${lib.makeBinPath [ nodejs ]}
  '';

  meta = with lib; {
    description = "Standalone MCP server exposing Perplexity (Pro/Max) web search to any MCP client";
    homepage = "https://github.com/ivanrvpereira/pi-perplexity";
    license = licenses.mit;
    mainProgram = "pi-perplexity-mcp";
    platforms = platforms.linux;
  };
}
