import { beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { AuthRequiredError } from "../src/api/http.js";
import { run } from "../src/commands/util.js";

/** run() json-mode exit codes: 2 auth / 1 other / 0 ok (README "Exit codes"). */
describe("commands/util — run() json error mapping", () => {
  let cfgDir: string;
  beforeEach(async () => {
    cfgDir = await mkdtemp(join(tmpdir(), "pplx-run-"));
    process.env.PPLX_CONFIG_DIR = cfgDir;
    process.env.PPLX_COOKIE = "";
    delete process.env.PPLX_COOKIE;
    process.exitCode = undefined;
  });

  it("json mode maps AuthRequiredError to exit code 2", async () => {
    await run(true, () => Promise.reject(new AuthRequiredError("not logged in")));
    expect(process.exitCode).toBe(2);
  });

  it("json mode maps other errors to exit code 1", async () => {
    await run(true, () => Promise.reject(new Error("boom")));
    expect(process.exitCode).toBe(1);
  });

  it("json mode leaves exit code at 0/unset on success", async () => {
    process.exitCode = 0;
    await run(true, () => Promise.resolve());
    // bun cannot unset process.exitCode once assigned; 0 (default) is equivalent.
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("non-json mode rethrows for the index.ts fail handler", async () => {
    expect(run(false, () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
  });
});
