{
  lib,
  stdenvNoCC,
  bun,
}:
let
  # Single source of truth for the version: cli/package.json.
  version = (lib.importJSON ./cli/package.json).version;

  # Fetch npm deps in a fixed-output derivation (network allowed here, not in
  # the main build). Reuses cli/bun.lock; --frozen-lockfile keeps it honest.
  fetchBunDeps =
    { src, hash }:
    stdenvNoCC.mkDerivation {
      pname = "pplx-bun-deps";
      inherit version src;
      nativeBuildInputs = [ bun ];

      buildPhase = ''
        runHook preBuild
        export HOME=$TMPDIR
        export XDG_CACHE_HOME=$TMPDIR/xdg-cache
        bun install --frozen-lockfile --production --ignore-scripts --no-progress
        runHook postBuild
      '';

      installPhase = ''
        runHook preInstall
        mkdir -p $out
        cp -R node_modules $out/node_modules
        cp bun.lock package.json $out/
        runHook postInstall
      '';

      dontFixup = true;
      outputHashAlgo = "sha256";
      outputHashMode = "recursive";
      outputHash = hash;
    };

  src = ./cli;

  bunDeps = fetchBunDeps {
    inherit src;
    hash = "sha256-A0MWvmLAsI0yMr6rvYRYbDuS0sZAP53lrN3WhmtHQ2c=";
  };
in
stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "pplx";
  inherit version;
  inherit src;

  nativeBuildInputs = [ bun ];

  buildPhase = ''
    runHook preBuild

    # Reuse the prefetched deps so this phase needs no network.
    cp -R ${bunDeps}/node_modules ./node_modules
    chmod -R u+w node_modules

    export HOME=$TMPDIR
    export XDG_CACHE_HOME=$TMPDIR/xdg-cache

    # Single self-contained bundle targeting the bun runtime (bun:sqlite and
    # other bun builtins stay external, provided by the bun interpreter).
    bun build --target=bun --minify --outfile=pplx.js ./src/index.ts

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    install -Dm644 pplx.js $out/lib/pplx/pplx.js

    # `pplx` is the bundle itself with its shebang pointed at nix's bun
    # (patchShebangs resolves `bun` from nativeBuildInputs).
    install -Dm755 pplx.js $out/bin/pplx
    patchShebangs $out/bin/pplx

    # Agent skills ship alongside the CLI.
    install -Dm644 ${finalAttrs.src}/skills/perplexity-cli/SKILL.md \
      $out/share/pplx/skills/perplexity-cli/SKILL.md

    runHook postInstall
  '';

  meta = {
    description = "Perplexity CLI — ask, deep research, and threads via your Pro/Max web session";
    longDescription = ''
      Standalone Bun + TypeScript CLI for Perplexity: streaming cited answers,
      deep research, thread history, and spaces — authenticated with a
      Perplexity Pro/Max web session (cookie auth), no API key. The underlying
      web API is reverse-engineered and can break without notice.
    '';
    homepage = "https://github.com/ivanrvpereira/pi-perplexity";
    license = lib.licenses.mit;
    sourceProvenance = [ lib.sourceTypes.fromSource ];
    maintainers = [ ];
    mainProgram = "pplx";
    platforms = lib.platforms.all;
  };
})
