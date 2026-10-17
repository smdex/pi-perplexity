import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askCommand } from "../src/commands/ask.js";
import { saveAuth } from "../src/config.js";

// Synthetic full-state markdown snapshots, a form demonstrated by the captures.
const frame = (text: string, completed = false): string =>
  `event: message\ndata: ${JSON.stringify({
    status: completed ? "COMPLETED" : "PENDING",
    final: true, // PENDING final:true is NOT completion (captured protocol trap).
    blocks: [{ intended_usage: "ask_text_0_markdown", markdown_block: { chunks: [text] } }],
  })}\n\n`;
const end = "event: end_of_stream\ndata: {}\n\n";
let dir: string;
let writes: string[];
let controller: ReadableStreamDefaultController<Uint8Array>;
let cancelled: boolean;
let ready: boolean;
const originalFetch = globalThis.fetch;
const originalWrite = process.stdout.write;
const originalTTY = process.stdout.isTTY;
const originalEnv = { ...process.env };
const encoder = new TextEncoder();
const push = (text: string): void => controller.enqueue(encoder.encode(text));
const output = (): string => writes.join("");
const invoke = (args: Record<string, unknown> = {}): Promise<void> =>
  (askCommand.handler as (args: Record<string, unknown>) => Promise<void>)({ query: ["test"], ...args });
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error("expected output before completion, but stream stalled");
}
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pplx-output-"));
  process.env.HOME = dir;
  process.env.PPLX_CONFIG_DIR = join(dir, "config");
  process.env.PPLX_CACHE_DIR = join(dir, "cache");
  process.env.PPLX_COOKIE = "";
  process.env.PPLX_NO_SPINNER = "1";
  await saveAuth({ kind: "cookies", cookies: ["__Secure-next-auth.session-token=fake", "pplx.session-id=fake"],
    accountUuid: "fake", sessionExpires: null, email: null, bearerToken: null, source: "paste", createdAt: "2026-01-01" });
  writes = [];
  cancelled = false;
  ready = false;
  process.stdout.write = ((chunk: unknown) => { writes.push(String(chunk)); return true; }) as typeof process.stdout.write;
  Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true, writable: true });
  globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
    start(c) { controller = c; ready = true; }, cancel() { cancelled = true; },
  }), { headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
});
afterEach(async () => {
  globalThis.fetch = originalFetch;
  process.stdout.write = originalWrite;
  Object.defineProperty(process.stdout, "isTTY", { value: originalTTY, configurable: true, writable: true });
  process.env = { ...originalEnv };
  process.exitCode = 0;
  await rm(dir, { recursive: true, force: true });
});

test("redirected output buffers revisions and emits only the final answer without ANSI", async () => {
  const handler = invoke();
  await until(() => ready);
  push(frame("Hello stale"));
  await Bun.sleep(20);
  expect(output()).toBe("");
  push(frame("Hi"));
  push(frame("Hi 世界 👋", true));
  push(end);
  await handler;
  expect(output()).toBe("Hi 世界 👋\n\n## Meta\nModel: unknown\n");
  expect(cancelled).toBe(true);
});

// Small independent terminal model: alternate screen and clear/home operations.
// No width approximation: the renderer must not rely on cursor-up row counts.
function screen(bytes: string): { main: string; preview: string; alternate: boolean } {
  let main = "prompt$\n";
  let preview = "";
  let alternate = false;
  for (const token of bytes.split(/(\x1b\[\?1049[hl]|\x1b\[2J|\x1b\[H)/)) {
    if (token === "\x1b[?1049h") { alternate = true; preview = ""; }
    else if (token === "\x1b[?1049l") alternate = false;
    else if (token === "\x1b[2J") { if (alternate) preview = ""; else main = ""; }
    else if (token !== "\x1b[H") { if (alternate) preview += token; else main += token; }
  }
  return { main, preview, alternate };
}

test("TTY shows shrink/rewrite/regrowth, repeats and Unicode before completion, preserving surrounding output", async () => {
  process.stdout.isTTY = true;
  const handler = invoke({ save: join(dir, "preview-result") });
  await until(() => ready);
  const snapshots = ["Hello", "Hi", "", "さようなら 👋 é", "X".repeat(240) + "\n" + "Y".repeat(240), "Final paragraph without newline"];
  for (const snapshot of snapshots) {
    push(frame(snapshot));
    await until(() => screen(output()).alternate && screen(output()).preview === snapshot);
    const beforeRepeat = output();
    push(frame(snapshot));
    await Bun.sleep(10);
    expect(output()).toBe(beforeRepeat);
    expect(screen(output()).main).toBe("prompt$\n");
  }
  push(frame("Final paragraph without newline", true));
  push(end);
  await handler;
  expect(await readFile(join(dir, "preview-result"), "utf8")).toBe("Final paragraph without newline\n\n## Meta\nModel: unknown");
  expect(screen(output()).alternate).toBe(false);
  expect(screen(output()).main).toBe("prompt$\nFinal paragraph without newline\n\n## Meta\nModel: unknown\n");
});

test("a truncated stream is an error, not a successful partial answer", async () => {
  const handler = invoke();
  const outcome = handler.then(() => null, (error: unknown) => error);
  await until(() => ready);
  push(frame("incomplete"));
  push(end);
  expect(await outcome).toBeInstanceOf(Error);
  expect(String(await outcome)).toContain("ended before completion");
  expect(output()).toBe("");
});

test("SIGINT cancels a parked stream, restores the terminal and removes signal listeners", async () => {
  process.stdout.isTTY = true;
  const listeners = process.listenerCount("SIGINT");
  const handler = invoke();
  const outcome = handler.then(() => null, (error: unknown) => error);
  await until(() => ready);
  push(frame("partial"));
  await until(() => output().includes("partial"));
  process.emit("SIGINT");
  const result = await Promise.race([outcome, Bun.sleep(100).then(() => "still waiting")]);
  expect(result).toBeInstanceOf(Error);
  expect((result as Error).name).toBe("AbortError");
  expect(cancelled).toBe(true);
  expect(screen(output()).alternate).toBe(false);
  expect(screen(output()).main).toBe("prompt$\n");
  expect(process.listenerCount("SIGINT")).toBe(listeners);
});

for (const json of [false, true]) {
  test(`${json ? "JSON" : "--no-stream"} stays buffered on TTY and saves the final revision without controls`, async () => {
    process.stdout.isTTY = true;
    const path = join(dir, "reply");
    const handler = invoke({ json, stream: false, save: path });
    await until(() => ready);
    push(frame("stale"));
    await Bun.sleep(10);
    expect(output()).toBe("");
    push(frame("Final 世界", true));
    push(end);
    await handler;
    const saved = await readFile(path, "utf8");
    expect(output()).not.toContain("\x1b");
    expect(output()).not.toContain("stale");
    if (json) {
      expect(JSON.parse(output()).answer).toBe("Final 世界");
      expect(output()).toBe(`${saved}\n`);
    } else {
      expect(output()).toBe("Final 世界\n\n## Meta\nModel: unknown\n");
      expect(saved).toBe("Final 世界\n\n## Meta\nModel: unknown");
    }
  });
}

for (const failure of ["transport", "truncated"] as const) {
  test(`TTY restores its original screen after ${failure} failure`, async () => {
    process.stdout.isTTY = true;
    const handler = invoke({ save: join(dir, "not-saved") });
    const outcome = handler.then(() => null, (error: unknown) => error);
    await until(() => ready);
    push(frame("partial"));
    await until(() => screen(output()).alternate);
    if (failure === "transport") controller.error(new Error("connection reset"));
    else controller.close();
    expect(await outcome).toBeInstanceOf(Error);
    expect(screen(output()).alternate).toBe(false);
    expect(screen(output()).main).toBe("prompt$\n");
    expect(await Bun.file(join(dir, "not-saved")).exists()).toBe(false);
  });
}

test("JSON SIGTERM returns only an error envelope and cancellation exit code", async () => {
  const handler = invoke({ json: true });
  await until(() => ready);
  push(frame("partial"));
  await Bun.sleep(10);
  process.emit("SIGTERM");
  await Promise.race([handler, Bun.sleep(200)]);
  expect(JSON.parse(output())).toEqual({ error: "interrupted" });
  expect(process.exitCode).toBe(130);
});

test("captured diff replacement and direct snapshot forms merge without duplicated chunks across byte splits", async () => {
  process.stdout.isTTY = true;
  const handler = invoke();
  await until(() => ready);
  const patch = `event: message\ndata: ${JSON.stringify({ status: "PENDING", final: true, blocks: [{
    intended_usage: "ask_text_0_markdown", diff_block: { field: "markdown_block", patches: [
      { op: "replace", path: "", value: { chunks: ["世界", " 👋"] } },
    ] },
  }] })}\n\n`;
  // Split even UTF-8 glyphs, not just JS character boundaries.
  for (const byte of encoder.encode(patch)) controller.enqueue(Uint8Array.of(byte));
  await until(() => screen(output()).preview === "世界 👋");
  push(frame("世界 👋", true));
  push(end);
  await handler;
  expect(screen(output()).main).toBe("prompt$\n世界 👋\n\n## Meta\nModel: unknown\n");
});
