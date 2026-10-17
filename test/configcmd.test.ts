import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configCommand } from "../src/commands/config.js";
import { loadSettings, settingsPath } from "../src/config.js";

/**
 * pplx config get/set/unset at the public command boundary: argv record in,
 * stdout/exit behavior out. Settings live in a fresh PPLX_CONFIG_DIR per file.
 */

let cfgDir: string;

beforeAll(async () => {
  cfgDir = await mkdtemp(join(tmpdir(), "pplx-configcmd-"));
  process.env.PPLX_CONFIG_DIR = cfgDir;
});

afterAll(async () => {
  delete process.env.PPLX_CONFIG_DIR;
  await rm(cfgDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(settingsPath(), { force: true });
});

/** Run the command handler with a raw argv record (yargs types are structural). */
async function runConfig(argv: Record<string, unknown>): Promise<void> {
  const handler = configCommand.handler as (a: Record<string, unknown>) => Promise<void>;
  await handler(argv);
}

/** Capture everything the handler writes to stdout. */
async function captureStdout(argv: Record<string, unknown>): Promise<string> {
  const chunks: string[] = [];
  const target = process.stdout as unknown as { write: (c: unknown) => boolean };
  const original = target.write.bind(process.stdout);
  target.write = (chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    await runConfig(argv);
  } finally {
    target.write = original;
  }
  return chunks.join("");
}

describe("pplx config — listing", () => {
  it("bare `config` lists configured defaults", async () => {
    await runConfig({ action: "set", key: "model", value: ["glm_5_3_thinking"] });
    await runConfig({ action: "set", key: "sources", value: ["web", "scholar"] });
    const text = await captureStdout({ action: undefined, key: undefined, value: undefined });
    expect(text).toContain("model: glm_5_3_thinking");
    expect(text).toContain("sources: web scholar");
  });

  it("bare `config` with no settings points at `config set`", async () => {
    const text = await captureStdout({});
    expect(text).toMatch(/no defaults configured/i);
  });

  it("`config get` lists all settings; `--json` prints the settings object", async () => {
    await runConfig({ action: "set", key: "space", value: ["Budgets"] });
    expect(await captureStdout({ action: "get" })).toContain("space: Budgets");
    expect(JSON.parse(await captureStdout({ action: "get", json: true }))).toEqual({ space: "Budgets" });
    expect(JSON.parse(await captureStdout({ action: undefined, json: true }))).toEqual({ space: "Budgets" });
  });
});

describe("pplx config — get", () => {
  it("prints a configured value; --json prints the JSON value", async () => {
    await runConfig({ action: "set", key: "sources", value: ["web", "scholar"] });
    expect(await captureStdout({ action: "get", key: "sources" })).toBe("sources: web scholar\n");
    expect(await captureStdout({ action: "get", key: "sources", json: true })).toBe('["web","scholar"]\n');
  });

  it("prints '(not set)' / null for an unset key instead of failing", async () => {
    expect(await captureStdout({ action: "get", key: "model" })).toBe("model: (not set)\n");
    expect(await captureStdout({ action: "get", key: "model", json: true })).toBe("null\n");
  });

  it("rejects an unknown key, naming the valid ones", async () => {
    await expect(runConfig({ action: "get", key: "bogus" })).rejects.toThrow(/bogus.*model.*sources.*space|bogus/);
  });
});

describe("pplx config — set", () => {
  it("persists model / sources / space and confirms on stdout", async () => {
    expect(await captureStdout({ action: "set", key: "model", value: ["glm_5_3_thinking"] })).toContain(
      "model=glm_5_3_thinking",
    );
    expect(await captureStdout({ action: "set", key: "sources", value: ["web", "scholar"] })).toContain(
      "sources=web scholar",
    );
    expect(await captureStdout({ action: "set", key: "space", value: ["Budgets"] })).toContain("space=Budgets");
    expect(await loadSettings()).toEqual({ model: "glm_5_3_thinking", sources: ["web", "scholar"], space: "Budgets" });
  });

  it("dedupes repeated source ids preserving order", async () => {
    await runConfig({ action: "set", key: "sources", value: ["scholar", "web", "scholar"] });
    expect(await loadSettings()).toEqual({ sources: ["scholar", "web"] });
  });

  it("rejects missing values, multi-values on scalar keys, and unknown keys — file untouched", async () => {
    await runConfig({ action: "set", key: "model", value: ["keep"] });
    await expect(runConfig({ action: "set", key: "model", value: [] })).rejects.toThrow(/value/i);
    await expect(runConfig({ action: "set", key: "model", value: ["a", "b"] })).rejects.toThrow(/exactly one/i);
    await expect(runConfig({ action: "set", key: "space" })).rejects.toThrow(/value/i);
    await expect(runConfig({ action: "set", key: "nope", value: ["x"] })).rejects.toThrow(/nope/);
    await expect(runConfig({ action: "set", key: "sources", value: [""] })).rejects.toThrow(/sources/);
    expect(await loadSettings()).toEqual({ model: "keep" });
  });

  it("rejects an unknown action with a usage hint", async () => {
    await expect(runConfig({ action: "frobnicate", key: "model", value: ["x"] })).rejects.toThrow(/get|set|unset/);
  });
});

describe("pplx config — unset", () => {
  it("removes one key, keeps the others", async () => {
    await runConfig({ action: "set", key: "model", value: ["m"] });
    await runConfig({ action: "set", key: "space", value: ["Budgets"] });
    await runConfig({ action: "unset", key: "space" });
    expect(await loadSettings()).toEqual({ model: "m" });
  });

  it("is idempotent: unsetting an unset key succeeds with a note", async () => {
    expect(await captureStdout({ action: "unset", key: "model" })).toMatch(/not set/i);
  });

  it("rejects an unknown key", async () => {
    await expect(runConfig({ action: "unset", key: "bogus" })).rejects.toThrow(/bogus/);
  });
});

describe("pplx config — JSON mutations", () => {
  it("set and unset emit JSON when requested", async () => {
    expect(JSON.parse(await captureStdout({ action: "set", key: "model", value: ["m"], json: true }))).toEqual({ model: "m" });
    expect(JSON.parse(await captureStdout({ action: "unset", key: "model", json: true }))).toEqual({});
    expect(JSON.parse(await captureStdout({ action: "unset", key: "model", json: true }))).toEqual({});
  });
});

// Exercise registration and positional parsing too; no auth or network is needed.
async function cli(args: string[]) {
  const child = Bun.spawn([process.execPath, "src/index.ts", "config", ...args], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, HOME: cfgDir, PPLX_CONFIG_DIR: cfgDir, PPLX_CACHE_DIR: join(cfgDir, "cache"), PPLX_COOKIE: "" },
    stdout: "pipe", stderr: "pipe",
  });
  return { code: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() };
}

describe("pplx config — executable", () => {
  it("persists quoted values across invocations and unsets without touching other keys", async () => {
    expect((await cli(["set", "space", "Ops: linux"])).code).toBe(0);
    expect((await cli(["set", "sources", "web", "scholar"])).code).toBe(0);
    const read = await cli(["get", "--json"]);
    expect(read.code).toBe(0);
    expect(JSON.parse(read.stdout)).toEqual({ space: "Ops: linux", sources: ["web", "scholar"] });
    expect((await cli(["unset", "space"])).code).toBe(0);
    expect(JSON.parse((await cli(["get", "--json"])).stdout)).toEqual({ sources: ["web", "scholar"] });
  });

  it("rejects malformed writes with a nonzero code and preserves persisted values", async () => {
    await cli(["set", "model", "keep"]);
    const invalid = await cli(["set", "unknown", "x"]);
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain("unknown setting");
    expect(JSON.parse((await cli(["get", "--json"])).stdout)).toEqual({ model: "keep" });
  });

  it("documents settings, replacement, and scope bypass in help", async () => {
    const help = await cli(["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("pplx config set sources");
    expect(help.stdout).toContain("--no-space");
    expect(help.stdout).toContain("--sources");
  });
});
