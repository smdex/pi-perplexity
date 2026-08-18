import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "../test-helpers.js";

import { defaultToonDeps, renderToon, type ToonRenderDeps } from "../../src/format/toon.js";

const ENV_KEY = "TOON_TRU_BIN";
const original = process.env[ENV_KEY];

beforeEach(() => {
  delete process.env[ENV_KEY];
});
afterEach(() => {
  if (original === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = original;
});

const PAYLOAD = { ok: true, answer: "hi", sources: [{ name: "One", url: "https://one.example" }] };

describe("renderToon (in-process encoder)", () => {
  test("uses the injected encoder when TOON_TRU_BIN is unset", async () => {
    const deps: ToonRenderDeps = {
      encode: (data) => `ENC:${(data as { answer: string }).answer}`,
      pipeThrough: () => {
        throw new Error("pipeThrough must not be called");
      },
    };
    expect(await renderToon(PAYLOAD, deps)).toBe("ENC:hi");
  });

  test("built-in default encoder produces TOON output", async () => {
    const out = await renderToon(PAYLOAD, defaultToonDeps);
    expect(out).toContain("ok: true");
    expect(out).toContain("answer: hi");
    // TOON quotes values that contain "://".
    expect(out).toContain('One,"https://one.example"');
  });
});

describe("renderToon (TOON_TRU_BIN pipe)", () => {
  test("pipes JSON through the configured binary and returns its stdout", async () => {
    process.env[ENV_KEY] = "/path/to/tru";
    const piped: Array<{ bin: string; input: string }> = [];
    const deps: ToonRenderDeps = {
      encode: () => {
        throw new Error("encode must not be called");
      },
      pipeThrough: async (bin, input) => {
        piped.push({ bin, input });
        return "TOON-FROM-BIN";
      },
    };
    expect(await renderToon(PAYLOAD, deps)).toBe("TOON-FROM-BIN");
    expect(piped).toEqual([{ bin: "/path/to/tru", input: JSON.stringify(PAYLOAD) }]);
  });

  test("real pipe via a /bin/sh echo shim returns the JSON input unchanged", async () => {
    // NixOS has no /bin/cat; a #!/bin/sh script is the portable fixture.
    const binDir = mkdtempSync(join(tmpdir(), "pi-perplexity-toon-"));
    const binPath = join(binDir, "tru-shim");
    writeFileSync(binPath, "#!/bin/sh\nexec cat\n", { mode: 0o755 });
    chmodSync(binPath, 0o755);

    process.env[ENV_KEY] = binPath;
    expect(await renderToon(PAYLOAD, defaultToonDeps)).toBe(JSON.stringify(PAYLOAD));
  });

  test("falls back to the built-in encoder when the binary exits nonzero", async () => {
    const binDir = mkdtempSync(join(tmpdir(), "pi-perplexity-toon-"));
    const binPath = join(binDir, "tru-fail");
    writeFileSync(binPath, "#!/bin/sh\nexit 3\n", { mode: 0o755 });
    chmodSync(binPath, 0o755);

    process.env[ENV_KEY] = binPath;
    const out = await renderToon(PAYLOAD, defaultToonDeps);
    expect(out).toContain("ok: true");
  });

  test("falls back when the binary does not exist", async () => {
    process.env[ENV_KEY] = "/nonexistent/tru-bin";
    const out = await renderToon(PAYLOAD, defaultToonDeps);
    expect(out).toContain("answer: hi");
  });

  test("falls back via injected deps on binary error", async () => {
    process.env[ENV_KEY] = "/path/to/tru";
    const deps: ToonRenderDeps = {
      encode: () => "ENC:fallback",
      pipeThrough: async () => {
        throw new Error("bin exploded");
      },
    };
    expect(await renderToon(PAYLOAD, deps)).toBe("ENC:fallback");
  });
});
