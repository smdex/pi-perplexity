import assert from "node:assert/strict";
import { test } from "node:test";
import register from "../src/index.js";
import { createFakePplx, readJson, withPath, removeDirSoon } from "./fake-pplx.js";

function tool() {
  let registered: any;
  register({ registerTool(value: unknown) { registered = value; }, registerCommand() {} } as any);
  return registered;
}

test("tool delegates to installed pplx without injecting defaults or prompting", async () => {
  const fake = await createFakePplx();
  removeDirSoon(fake.dir);
  withPath(fake.dir);
  const updates: any[] = [];
  const result = await tool().execute("call-1", { query: "why is the sky blue" }, undefined,
    (update: unknown) => updates.push(update), { ui: { input() { throw new Error("must not prompt"); } } });
  assert.deepEqual(await readJson(fake.argvFile), ["ask", "--json", "why is the sky blue"]);
  assert.match(result.content[0].text, /## Answer\nSky is blue/);
  assert.match(result.content[0].text, /\[1\] NASA/);
  assert.equal(result.details.model, "gemini38flash");
  assert.equal(result.details.sourceCount, 1);
  assert.equal(result.details.thread, "3f2b8c1a-4d5e-4f6a-9b7c-1d2e3f4a5b6c");
  assert.ok(updates.length > 0);
  assert.ok(!JSON.stringify(result).includes("rw-token"));
});

test("explicit overrides remain literal argv, including option-like queries and filenames", async () => {
  const fake = await createFakePplx();
  removeDirSoon(fake.dir);
  withPath(fake.dir);
  const result = await tool().execute("override", {
    query: '-why $(touch /tmp/not-a-shell) "quoted"', model: "sonar", recency: "week",
    sources: ["web", "scholar"], files: ["--help", "/tmp/a b.pdf"],
    thread: "https://www.perplexity.ai/search/3f2b8c1a-4d5e-4f6a-9b7c-1d2e3f4a5b6c",
    continue: true, space: "My Space", limit: 1,
  });
  assert.deepEqual(await readJson(fake.argvFile), [
    "ask", "--json", ' -why $(touch /tmp/not-a-shell) "quoted"', "--model=sonar", "--recency=week", "--sources=web", "--sources=scholar",
    "--attach=--help", "--attach=/tmp/a b.pdf", "--thread=3f2b8c1a-4d5e-4f6a-9b7c-1d2e3f4a5b6c",
    "--continue", "--space=My Space",
  ]);
  assert.equal(result.details.sourceCount, 1);
});

for (const [mode, message] of [
  ["auth", /pplx login/], ["auth-bare", /pplx login/], ["fail", /HTTP 500/],
  ["stderr", /Invalid source identifier/], ["garbage", /JSON result/], ["empty-object", /JSON result/],
] as const) {
  test(`${mode} CLI outcome is a readable tool error without prompting`, async () => {
    const fake = await createFakePplx(mode);
    removeDirSoon(fake.dir);
    withPath(fake.dir);
    const result = await tool().execute("error", { query: "q" }, undefined, undefined,
      { ui: { input() { assert.fail("must not prompt"); } } });
    assert.equal(result.details.isError, true);
    assert.match(result.content[0].text, message);
  });
}

test("missing installed executable reports installation and PATH advice", async () => {
  const fake = await createFakePplx();
  removeDirSoon(fake.dir);
  withPath(`${fake.dir}/missing`, { replace: true });
  const result = await tool().execute("missing", { query: "q" });
  assert.equal(result.details.isError, true);
  assert.match(result.content[0].text, /install.*pplx CLI/);
  assert.match(result.content[0].text, /PATH/);
});

test("malformed nested CLI output is reported as invalid JSON result, not a formatter crash", async () => {
  const fake = await createFakePplx("bad-source");
  removeDirSoon(fake.dir);
  withPath(fake.dir);
  const result = await tool().execute("malformed", { query: "q" });
  assert.equal(result.details.isError, true);
  assert.match(result.content[0].text, /JSON result/);
});

test("UTF-8 characters split across process writes survive unchanged", async () => {
  const fake = await createFakePplx("unicode");
  removeDirSoon(fake.dir);
  withPath(fake.dir);
  const result = await tool().execute("unicode", { query: "q" });
  assert.match(result.content[0].text, /你好 🌍/);
});

test("already cancelled calls do not start a CLI process", async () => {
  const fake = await createFakePplx();
  removeDirSoon(fake.dir);
  withPath(fake.dir);
  const controller = new AbortController();
  controller.abort();
  const result = await tool().execute("cancelled", { query: "q" }, controller.signal);
  const { exists } = await import("./fake-pplx.js");
  assert.equal(await exists(fake.argvFile), false);
  assert.equal(result.details.cancelled, true);
  assert.match(result.content[0].text, /cancelled/);
});

for (const mode of ["hang", "stubborn"]) {
  test(`cancellation terminates and awaits a ${mode} child`, { timeout: 10_000 }, async () => {
    const { exists, waitFor } = await import("./fake-pplx.js");
    const fake = await createFakePplx(mode);
    removeDirSoon(fake.dir);
    withPath(fake.dir);
    const controller = new AbortController();
    const pending = tool().execute("cancel", { query: "q" }, controller.signal);
    try {
      await waitFor(() => exists(fake.argvFile));
    } finally {
      controller.abort();
    }
    const result = await pending;
    assert.equal(await exists(fake.killedFile), true);
    const pid = await readJson(fake.pidFile) as number;
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    assert.equal(result.details.cancelled, true);
    assert.equal(result.details.isError, true);
    assert.match(result.content[0].text, /cancelled/);
  });
}

test("relative attachments are resolved in the Pi session working directory", async () => {
  const fake = await createFakePplx("cwd");
  removeDirSoon(fake.dir);
  withPath(fake.dir);
  const result = await tool().execute("cwd", { query: "q", files: ["notes.txt"] }, undefined, undefined, { cwd: fake.dir });
  assert.match(result.content[0].text, new RegExp(`## Answer\\n${fake.dir}`));
});

test("explicit history choice is forwarded, never silently changed for a space", async () => {
  const fake = await createFakePplx();
  removeDirSoon(fake.dir);
  withPath(fake.dir);
  await tool().execute("history", { query: "q", space: "Team", incognito: false });
  assert.deepEqual(await readJson(fake.argvFile), ["ask", "--json", "q", "--space=Team", "--no-incognito"]);
});

test("adapter argv reaches actual CLI authentication rather than failing yargs query parsing", async () => {
  const { spawnSync } = await import("node:child_process");
  const { resolve, join } = await import("node:path");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  for (const query of ["ordinary question", '--literal ; $(touch NO) "quoted"']) {
    const fake = await createFakePplx();
    removeDirSoon(fake.dir);
    withPath(fake.dir);
    await tool().execute("parser", { query, model: "sonar", sources: ["web", "scholar"], recency: "week" });
    const args = await readJson(fake.argvFile) as string[];
    const home = mkdtempSync(join(tmpdir(), "pi-cli-parser-"));
    removeDirSoon(home);
    const probe = spawnSync("bun", [resolve("../../src/index.ts"), ...args], {
      env: { ...process.env, HOME: home, PPLX_CONFIG_DIR: join(home, "config"), PPLX_CACHE_DIR: join(home, "cache"), PPLX_COOKIE: "" },
      encoding: "utf8", timeout: 5_000,
    });
    assert.equal(probe.status, 2, probe.stderr || probe.stdout || String(probe.error));
    assert.match(JSON.parse(probe.stdout).error, /pplx login/);
  }
});

test("empty explicit sources cannot silently fall back to a configured scope", async () => {
  const fake = await createFakePplx();
  removeDirSoon(fake.dir);
  withPath(fake.dir);
  const result = await tool().execute("scope", { query: "q", sources: [] });
  const { exists } = await import("./fake-pplx.js");
  assert.equal(result.details.isError, true);
  assert.match(result.content[0].text, /sources.*nonempty/i);
  assert.equal(await exists(fake.argvFile), false);
});

test("POSIX cancellation terminates CLI wrapper descendants too", { skip: process.platform === "win32" }, async () => {
  const { exists, waitFor } = await import("./fake-pplx.js");
  const fake = await createFakePplx("wrapper");
  removeDirSoon(fake.dir);
  withPath(fake.dir);
  const controller = new AbortController();
  const pending = tool().execute("wrapper", { query: "q" }, controller.signal);
  await waitFor(() => exists(fake.descendantFile));
  const pid = await readJson(fake.descendantFile) as number;
  let timer: NodeJS.Timeout | undefined;
  try {
    controller.abort();
    const result = await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("descendant kept CLI pipes open after cancellation")), 1_000);
    })]);
    assert.equal(result.details.cancelled, true);
    assert.equal(await exists(fake.descendantKilledFile), true);
  } finally {
    if (timer) clearTimeout(timer);
    try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ }
    await pending;
  }
});
